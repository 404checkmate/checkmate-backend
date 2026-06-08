import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  ChecklistGeneratedBy,
  ChecklistItemSource,
  LlmStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OpenaiService, TripContext } from '../llm/openai.service';

/**
 * 통합 체크리스트 응답에서 쓰이는 단일 아이템 형태.
 * - 영속화 이전(메모리 전용) 상태에서도 쓰고, DB 에서 로드한 후에도 동일 shape 로 돌려준다.
 * - `id`, `isSelected`, `selectedAt` 는 "Candidate pool" 전환 이후부터 채워진다.
 */
export interface GeneratedChecklistItem {
  /** DB 에 저장된 경우의 ChecklistItem.id (stringified BigInt). 미영속 응답에서는 null. */
  id: string | null;
  title: string;
  description?: string;
  memo?: string;
  categoryCode: string;
  categoryLabel: string;
  prepType: 'item' | 'pre_booking' | 'pre_departure_check' | 'ai_recommend';
  baggageType: 'carry_on' | 'checked' | 'none';
  source: 'template' | 'llm' | 'user_added';
  isEssential: boolean;
  orderIndex: number;
  /** 사용자가 "내 체크리스트"에 담았는지. 후보 풀에서만 false 인 항목이 섞여있다. */
  isSelected: boolean;
  selectedAt: string | null;
  /** 사용자가 체크(완료)했는지. 후보 풀에서는 의미 없음. shared 항목의 공유 상태. */
  isChecked: boolean;
  /** 개인/공동 짐 구분 — personal 은 멤버별 체크, shared 는 공유 체크 + 담당자 */
  scope: 'personal' | 'shared';
  /** 공동 짐 담당자 userId (stringified) — serializeItem 경로용. getByTrip 은 assignee 로 풍부화 */
  assigneeUserId?: string | null;
  /** 마지막으로 편집/체크한 사용자 — 공동 편집 표시용 (getByTrip 에서만 채워짐) */
  lastActor?: { nickname: string; profileImageUrl: string | null; at: string } | null;
  /** 요청자 기준 체크 상태 — personal 은 내 행, shared 는 isChecked (getByTrip 에서만 채워짐) */
  myChecked?: boolean;
  /** personal 항목의 멤버 진척 집계 (getByTrip 에서만 채워짐) */
  personalSummary?: { checkedCount: number; memberCount: number } | null;
  /** shared 항목의 담당자 (getByTrip 에서만 채워짐) */
  assignee?: { userId: string; nickname: string; profileImageUrl: string | null } | null;
}

export interface GeneratedChecklist {
  tripId: string;
  context: TripContext;
  summary: {
    total: number;
    fromTemplate: number;
    fromLlm: number;
    duplicatesRemoved: number;
    llmTokensUsed: number;
    model: string | null;
    /** 'db-cached' 이면 기존 ChecklistItem 을 그대로 돌려준 것(OpenAI 미호출). */
    cacheStatus: 'fresh' | 'db-cached';
    /** 요청자 기준 준비율(%) — 내 개인 짐 체크 + 공동 짐 체크 기준 (getByTrip 에서만 채워짐) */
    myCompletionRate?: number;
  };
  sections: Array<{
    categoryCode: string;
    categoryLabel: string;
    items: GeneratedChecklistItem[];
  }>;
  items: GeneratedChecklistItem[];
}

type TripWithRelations = Prisma.TripGetPayload<{
  include: {
    country: true;
    cities: { include: { city: true } };
    companions: { include: { companionType: true } };
    travelStyles: { include: { travelStyle: true } };
  };
}>;

type PersistedChecklistItem = Prisma.ChecklistItemGetPayload<{
  include: { category: true };
}>;

/**
 * 프롬프트 dedup 구분용 — OpenAI 재호출 방지 목적.
 * 동일 trip 에 대해 이미 LlmGeneration 이 있으면 cache hit 으로 본다.
 */
const OPENAI_GENERATOR = 'openai:recommendAdditionalItems';

@Injectable()
export class ChecklistsService {
  private readonly logger = new Logger(ChecklistsService.name);
  /** 동일 context hash 에 대한 진행 중인 생성 요청을 dedup — 캐시 스탬피드 방지 */
  private readonly inflightContextRequests = new Map<string, Promise<GeneratedChecklist>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenaiService,
  ) {}

  // =========================================================
  // READ
  // =========================================================

  /**
   * 전세계 공통 기본 템플릿 조회 (countryId=null).
   * 비로그인 엔드포인트(@Public)에서 호출 — 큐레이션 페이지 저장하기 흐름 지원.
   */
  async getGlobalTemplates(): Promise<
    Array<{
      categoryCode: string;
      categoryLabel: string;
      items: Array<{
        id: string;
        title: string;
        prepType: string;
        baggageType: string;
        isEssential: boolean;
      }>;
    }>
  > {
    const templates = await this.prisma.checklistItemTemplate.findMany({
      where: { countryId: null },
      include: { category: true },
      orderBy: [{ category: { sortOrder: 'asc' } }, { id: 'asc' }],
    });

    const grouped = new Map<string, {
      categoryCode: string;
      categoryLabel: string;
      items: Array<{ id: string; title: string; prepType: string; baggageType: string; isEssential: boolean }>;
    }>();

    for (const t of templates) {
      const code = t.category.code;
      if (!grouped.has(code)) {
        grouped.set(code, { categoryCode: code, categoryLabel: t.category.labelKo, items: [] });
      }
      grouped.get(code)!.items.push({
        id: t.id.toString(),
        title: t.title,
        prepType: t.prepType,
        baggageType: t.baggageType,
        isEssential: t.isEssential,
      });
    }

    return Array.from(grouped.values());
  }

  /**
   * "내 체크리스트" 조회 — isSelected=true 인 아이템만 GeneratedChecklist 형태로 반환.
   * 후보 풀 전체(미선택 포함)가 필요하면 listCandidatesForTrip 를 사용.
   */
  async getByTrip(tripId: bigint, userId?: bigint): Promise<GeneratedChecklist> {
    const trip = await this.loadTripForContext(tripId);
    const checklist = await this.prisma.checklist.findUnique({
      where: { tripId },
      include: {
        items: {
          where: { isSelected: true, deletedAt: null },
          orderBy: { orderIndex: 'asc' },
          include: { category: true },
        },
      },
    });
    if (!checklist) throw new NotFoundException(`Checklist for trip ${tripId} not found`);
    const response = await this.buildResponseFromPersisted(
      trip,
      tripId.toString(),
      checklist.items,
      checklist.generatedBy,
    );
    await this.attachLastActors(response);
    if (userId != null) await this.attachPersonalState(response, tripId, userId);
    return response;
  }

  /**
   * 요청자 관점의 체크 상태를 부착 (개인/공동 짐 기능).
   * - myChecked: personal 은 내 personalChecks 행, shared 는 공유 isChecked
   * - personalSummary: personal 항목의 "n/m명 준비 완료" 집계 (현재 멤버 기준)
   * - assignee: shared 항목의 담당자 프로필
   * - summary.myCompletionRate: 내 기준 준비율(%)
   */
  private async attachPersonalState(
    checklist: GeneratedChecklist,
    tripId: bigint,
    userId: bigint,
  ): Promise<void> {
    const ids = checklist.items
      .map((i) => i.id)
      .filter((v): v is string => v != null)
      .map((v) => BigInt(v));

    const [trip, rows] = await Promise.all([
      this.prisma.trip.findFirst({
        where: { id: tripId },
        select: {
          userId: true,
          members: { where: { status: 'accepted' }, select: { userId: true } },
        },
      }),
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.checklistItem.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              scope: true,
              isChecked: true,
              assignee: { select: { id: true, nickname: true, profileImageUrl: true } },
              personalChecks: { where: { isChecked: true }, select: { userId: true } },
            },
          }),
    ]);

    const memberIds = new Set<bigint>([
      ...(trip ? [trip.userId] : []),
      ...(trip?.members.map((m) => m.userId) ?? []),
    ]);
    const memberCount = Math.max(memberIds.size, 1);
    const byId = new Map(rows.map((r) => [r.id.toString(), r]));

    // items 와 sections 는 같은 객체를 참조하지만, 복사본일 가능성까지 대비해 양쪽 순회
    const allItems = [...checklist.items, ...checklist.sections.flatMap((s) => s.items)];
    for (const item of allItems) {
      const row = item.id ? byId.get(item.id) : undefined;
      if (!row) continue;
      if (row.scope === 'shared') {
        item.myChecked = row.isChecked;
        item.personalSummary = null;
        item.assignee = row.assignee
          ? {
              userId: row.assignee.id.toString(),
              nickname: row.assignee.nickname,
              profileImageUrl: row.assignee.profileImageUrl,
            }
          : null;
      } else {
        const checkedMembers = row.personalChecks.filter((c) => memberIds.has(c.userId));
        item.myChecked = row.personalChecks.some((c) => c.userId === userId);
        item.personalSummary = {
          checkedCount: Math.min(checkedMembers.length, memberCount),
          memberCount,
        };
        item.assignee = null;
      }
    }

    const total = checklist.items.length;
    const myChecked = checklist.items.filter((i) => i.myChecked).length;
    checklist.summary.myCompletionRate = total === 0 ? 0 : (myChecked / total) * 100;
  }

  /**
   * 아이템별 마지막 수정자(편집/체크 감사 로그의 최신 1건)를 lastActor 로 부착.
   * 공동 편집 화면에서 "누가 마지막으로 만졌는지" 표시용.
   */
  private async attachLastActors(checklist: GeneratedChecklist): Promise<void> {
    const ids = checklist.items
      .map((i) => i.id)
      .filter((v): v is string => v != null)
      .map((v) => BigInt(v));
    if (ids.length === 0) return;

    const actorSelect = {
      itemId: true,
      occurredAt: true,
      user: { select: { nickname: true, profileImageUrl: true } },
    } as const;

    // distinct + (itemId, occurredAt desc) 정렬 → 아이템별 최신 1건
    const [edits, checks] = await Promise.all([
      this.prisma.checklistItemEdit.findMany({
        where: { itemId: { in: ids } },
        orderBy: [{ itemId: 'asc' }, { occurredAt: 'desc' }],
        distinct: ['itemId'],
        select: actorSelect,
      }),
      this.prisma.checklistItemCheck.findMany({
        where: { itemId: { in: ids } },
        orderBy: [{ itemId: 'asc' }, { occurredAt: 'desc' }],
        distinct: ['itemId'],
        select: actorSelect,
      }),
    ]);

    const latestByItem = new Map<string, { nickname: string; profileImageUrl: string | null; at: Date }>();
    for (const row of [...edits, ...checks]) {
      const key = row.itemId.toString();
      const prev = latestByItem.get(key);
      if (!prev || row.occurredAt > prev.at) {
        latestByItem.set(key, {
          nickname: row.user.nickname,
          profileImageUrl: row.user.profileImageUrl,
          at: row.occurredAt,
        });
      }
    }

    // items 와 sections 는 같은 객체를 참조하지만, 복사본일 가능성까지 대비해 양쪽 순회
    const allItems = [...checklist.items, ...checklist.sections.flatMap((s) => s.items)];
    for (const item of allItems) {
      const actor = item.id ? latestByItem.get(item.id) : undefined;
      if (actor) {
        item.lastActor = {
          nickname: actor.nickname,
          profileImageUrl: actor.profileImageUrl,
          at: actor.at.toISOString(),
        };
      }
    }
  }

  /**
   * Trip 에 영속화된 후보 풀 전체를 `GeneratedChecklist` 형태로 돌려준다.
   * `generateForTrip` 과 달리 자동 생성하지 않으므로, 먼저 POST /generate/:tripId 를 호출해야 한다.
   *
   * 케이스별 응답:
   *   - Checklist 행 자체가 없음          → 404 NotFoundException
   *   - 행은 있고 활성 아이템 없음(0개)   → 200 + { items: [], sections: [] }
   *   - 행 있고 아이템 있음               → 200 + 전체 후보 풀 (isSelected 무관)
   */
  async listCandidatesForTrip(tripId: bigint): Promise<GeneratedChecklist> {
    const trip = await this.loadTripForContext(tripId);
    const cached = await this.loadPersistedChecklistItems(tripId);
    if (!cached) {
      throw new NotFoundException(
        `Checklist for trip ${tripId} not found — 먼저 POST /checklists/generate/${tripId} 로 생성하세요.`,
      );
    }
    return this.buildResponseFromPersisted(
      trip,
      tripId.toString(),
      cached.items,
      cached.generatedBy,
    );
  }

  // =========================================================
  // GENERATE (idempotent)
  // =========================================================

  /**
   * 맞춤형 체크리스트 생성 (멱등).
   *
   *   1) 해당 trip 에 이미 `Checklist` + 아이템이 있으면 OpenAI 호출 **없이** DB 항목을 반환.
   *   2) 없으면 템플릿 + OpenAI 결과를 합쳐 DB 에 persist 후 반환.
   *
   * → 같은 `/trips/:id/search` 를 여러 번 방문해도 OpenAI 는 단 한 번만 호출된다.
   */
  async generateForTrip(tripId: bigint): Promise<GeneratedChecklist> {
    const trip = await this.loadTripForContext(tripId);

    const cached = await this.loadPersistedChecklistItems(tripId);
    if (cached && cached.items.length > 0) {
      this.logger.log(`[generateForTrip] cache hit trip=${tripId} items=${cached.items.length}`);
      return this.buildResponseFromPersisted(
        trip,
        tripId.toString(),
        cached.items,
        cached.generatedBy,
      );
    }

    const context = this.buildTripContext(trip);
    const built = await this.buildGeneratedChecklist(context, tripId.toString());

    // 멱등 보장: 동시 요청 두 건이 동시에 persist 를 시도해도 `tripId` unique 제약 + create 가 1건으로 수렴.
    try {
      await this.persistChecklist(tripId, built);
    } catch (e) {
      const err = e as Error;
      this.logger.warn(
        `[generateForTrip] persist failed (trip=${tripId}) — 이미 다른 요청이 persist 했을 가능성: ${err.message}`,
      );
      throw e;
    }

    // persist 후 DB 에서 다시 읽어 id/isSelected 가 채워진 응답을 돌려준다.
    // upsert 로 행이 보장되므로 reloaded 는 항상 non-null.
    const reloaded = await this.loadPersistedChecklistItems(tripId);
    return this.buildResponseFromPersisted(
      trip,
      tripId.toString(),
      reloaded!.items,
      reloaded!.generatedBy,
    );
  }

  /**
   * 백그라운드 생성 — 컨트롤러에서 await 없이 호출 (fire-and-forget).
   * 에러가 발생해도 throw 하지 않고 logger.error 만 기록한다.
   */
  async generateForTripBackground(tripId: bigint): Promise<void> {
    try {
      await this.generateForTrip(tripId);
    } catch (e) {
      this.logger.error(
        `[generateForTripBackground] trip=${tripId} failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Trip 이 DB 에 없는 경우에도 돌릴 수 있는 컨텍스트 기반 생성.
   * - persist 는 수행하지 않는다 (tripId 가 없으므로 ChecklistItem 을 저장할 위치가 없음).
   * - Phase 3 이후로는 프론트가 항상 먼저 Trip 을 만들고 `/generate/:tripId` 를 쓰는 것이 권장 경로.
   */
  async generateFromContext(
    context: TripContext,
    opts?: { tripIdLabel?: string },
  ): Promise<GeneratedChecklist> {
    const hash = this.buildContextHash(context);

    const cached = await this.loadContextCache(hash, context);
    if (cached) {
      this.logger.log(`[generateFromContext] cache hit hash=${hash.slice(0, 8)}`);
      return cached;
    }

    // 동일 hash 요청이 이미 진행 중이면 그 Promise를 공유 (OpenAI 중복 호출 방지)
    const inflight = this.inflightContextRequests.get(hash);
    if (inflight) {
      this.logger.log(`[generateFromContext] dedup hit hash=${hash.slice(0, 8)}`);
      return inflight;
    }

    const promise = this.buildGeneratedChecklist(context, opts?.tripIdLabel ?? 'context')
      .then((result) => {
        if (result.summary.fromLlm > 0) {
          this.saveContextCache(hash, context, result).catch((err) =>
            this.logger.warn(`[generateFromContext] cache save failed: ${(err as Error).message}`),
          );
        }
        return result;
      })
      .finally(() => {
        this.inflightContextRequests.delete(hash);
      });

    this.inflightContextRequests.set(hash, promise);
    return promise;
  }

  private buildContextHash(context: TripContext): string {
    const key = JSON.stringify({
      d: context.destination.trim().toLowerCase(),
      days: context.durationDays,
      s: context.season,
      c: [...(context.companions ?? [])].sort(),
      p: [...(context.purposes ?? [])].sort(),
    });
    return createHash('sha256').update(key).digest('hex');
  }

  private async loadContextCache(
    hash: string,
    originalContext: TripContext,
  ): Promise<GeneratedChecklist | null> {
    try {
      const row = await this.prisma.llmContextCache.findUnique({ where: { contextHash: hash } });
      if (!row) return null;

      if (row.expiresAt < new Date()) {
        this.prisma.llmContextCache.delete({ where: { id: row.id } }).catch(() => {});
        return null;
      }

      this.prisma.llmContextCache
        .update({ where: { id: row.id }, data: { hitCount: { increment: 1 } } })
        .catch(() => {});

      const items = row.items as unknown as GeneratedChecklistItem[];
      const summary = row.summary as unknown as GeneratedChecklist['summary'];
      const sections = await this.groupIntoSections(items);

      return {
        tripId: 'context',
        context: originalContext,
        summary: { ...summary, cacheStatus: 'db-cached' },
        sections,
        items,
      };
    } catch {
      return null;
    }
  }

  private async saveContextCache(
    hash: string,
    context: TripContext,
    result: GeneratedChecklist,
  ): Promise<void> {
    const CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48시간
    await this.prisma.llmContextCache.upsert({
      where: { contextHash: hash },
      create: {
        contextHash: hash,
        context: context as unknown as Prisma.InputJsonValue,
        items: result.items as unknown as Prisma.InputJsonValue,
        summary: result.summary as unknown as Prisma.InputJsonValue,
        model: result.summary.model ?? 'unknown',
        expiresAt: new Date(Date.now() + CACHE_TTL_MS),
      },
      update: {
        items: result.items as unknown as Prisma.InputJsonValue,
        summary: result.summary as unknown as Prisma.InputJsonValue,
        model: result.summary.model ?? 'unknown',
        expiresAt: new Date(Date.now() + CACHE_TTL_MS),
        hitCount: 0,
      },
    });
  }

  // =========================================================
  // BUILD PIPELINE (templates + OpenAI → merged)
  // =========================================================

  /**
   * 공통 파이프라인: DB 기본 템플릿 + OpenAI 추가 추천 → 중복 제거 → 카테고리별 섹션 그룹핑.
   */
  private async buildGeneratedChecklist(
    context: TripContext,
    tripIdLabel: string,
  ): Promise<GeneratedChecklist> {
    // --- 1) DB 기본 템플릿 ---
    const templateItems = await this.loadTemplateItems();

    // --- 2) OpenAI 추가 추천 ---
    let llmItems: GeneratedChecklistItem[] = [];
    let llmUsage: { tokens: number; model: string } | null = null;
    try {
      const categories = await this.prisma.checklistCategory.findMany();
      const categoryByCode = new Map(categories.map((c) => [c.code, c]));

      const { items, usage } = await this.openai.recommendAdditionalItems(
        context,
        templateItems.map((t) => t.title), // 실제 템플릿 목록 전달 — 중복 추천 회피
      );
      llmUsage = usage;
      llmItems = items.map((raw, idx) => {
        const category = categoryByCode.get(raw.category) ?? categoryByCode.get('ai_recommend');
        return {
          id: null,
          title: raw.title,
          description: raw.description,
          categoryCode: category?.code ?? 'ai_recommend',
          categoryLabel: category?.labelKo ?? 'AI 추천',
          prepType: 'ai_recommend' as const,
          baggageType: raw.baggage_type,
          source: 'llm' as const,
          isEssential: false,
          orderIndex: idx,
          isSelected: false,
          selectedAt: null,
          isChecked: false,
          scope: 'personal' as const,
        } satisfies GeneratedChecklistItem;
      });
    } catch (e) {
      this.logger.error(
        `[buildGeneratedChecklist] LLM call failed (trip=${tripIdLabel}): ${(e as Error).message}`,
      );
    }

    // --- 3) 중복 제거 (template 우선, LLM 은 같거나 "유사한" title 이면 버림) ---
    const seen = new Set<string>();
    const merged: GeneratedChecklistItem[] = [];
    let duplicatesRemoved = 0;

    const pushIfUnique = (item: GeneratedChecklistItem) => {
      const key = this.normalizeTitle(item.title);
      if (seen.has(key)) {
        duplicatesRemoved += 1;
        return;
      }
      seen.add(key);
      merged.push(item);
    };

    templateItems.forEach(pushIfUnique);
    // LLM 항목은 완전 일치 외에 변형 표현(소화제→소화 보조제 등)도 차단
    llmItems.forEach((item) => {
      const key = this.normalizeTitle(item.title);
      if (seen.has(key) || this.isVariantOfExisting(key, seen)) {
        duplicatesRemoved += 1;
        return;
      }
      seen.add(key);
      merged.push(item);
    });

    // orderIndex 를 전역적으로 재부여 (섹션 구분과 무관한 글로벌 순서 확정).
    merged.forEach((m, idx) => {
      m.orderIndex = idx;
    });

    // --- 4) 카테고리별 그룹핑 ---
    const sections = await this.groupIntoSections(merged);

    return {
      tripId: tripIdLabel,
      context,
      summary: {
        total: merged.length,
        fromTemplate: templateItems.length,
        fromLlm: llmItems.length,
        duplicatesRemoved,
        llmTokensUsed: llmUsage?.tokens ?? 0,
        model: llmUsage?.model ?? null,
        cacheStatus: 'fresh',
      },
      sections,
      items: merged,
    };
  }

  /**
   * 메모리 상의 generated 결과를 DB 에 영속화.
   * - Checklist 행이 없으면 생성, 있으면 재사용.
   * - 아이템 저장은 항상 실행 (기존 활성 아이템 타이틀 기준 중복 제거 후 INSERT).
   */
  private async persistChecklist(
    tripId: bigint,
    generated: GeneratedChecklist,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Checklist 행 보장 — 없을 때만 생성.
      // upsert 로 원자적 create-or-reuse — 동시 요청 시 UNIQUE 제약 위반 방지.
      const generatedBy = this.inferGeneratedBy(generated);
      const checklist = await tx.checklist.upsert({
        where: { tripId },
        create: { tripId, generatedBy, status: 'not_started' },
        update: {},
      });

      if (generated.items.length > 0) {
        // 기존 활성 아이템 타이틀로 중복 삽입 방지.
        const existingItems = await tx.checklistItem.findMany({
          where: { checklistId: checklist.id, deletedAt: null },
          select: { title: true },
        });
        const existingTitles = new Set(
          existingItems.map((e) => this.normalizeTitle(e.title)),
        );
        const newItems = generated.items.filter(
          (it) => !existingTitles.has(this.normalizeTitle(it.title)),
        );

        if (newItems.length > 0) {
          // ChecklistItem 에 저장할 카테고리 id 해소.
          const categoryCodes = Array.from(new Set(newItems.map((i) => i.categoryCode)));
          const categories = await tx.checklistCategory.findMany({
            where: { code: { in: categoryCodes } },
          });
          const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));
          // 안전망: 미등록 카테고리 코드는 'ai_recommend' 로 fallback.
          const fallback = categories.find((c) => c.code === 'ai_recommend');

          await tx.checklistItem.createMany({
            data: newItems.map((it) => {
              const categoryId =
                categoryIdByCode.get(it.categoryCode) ?? fallback?.id ?? categories[0]?.id;
              if (!categoryId) {
                throw new Error('[persistChecklist] seed 된 ChecklistCategory 가 하나도 없습니다.');
              }
              return {
                checklistId: checklist!.id,
                categoryId,
                title: it.title,
                description: it.description ?? null,
                prepType: it.prepType,
                baggageType: it.baggageType,
                source: (it.source === 'template'
                  ? ChecklistItemSource.template
                  : ChecklistItemSource.llm) as ChecklistItemSource,
                orderIndex: it.orderIndex,
                isSelected: false,
                selectedAt: null,
              };
            }),
          });
        }
      }

      // LLM 호출 이력 기록 — 후속 "같은 trip 에 다시 돌리지 말 것" 판단에도 쓸 수 있다.
      await tx.llmGeneration.create({
        data: {
          tripId,
          promptInput: generated.context as unknown as Prisma.InputJsonValue,
          responseRaw: {
            generator: OPENAI_GENERATOR,
            summary: generated.summary,
          } as Prisma.InputJsonValue,
          model: generated.summary.model ?? 'n/a',
          tokensUsed: generated.summary.llmTokensUsed,
          status: generated.summary.model ? LlmStatus.success : LlmStatus.failed,
        },
      });
    }, { timeout: 10000, maxWait: 5000 });

    this.logger.log(
      `[persistChecklist] trip=${tripId} items=${generated.items.length} tokens=${generated.summary.llmTokensUsed} model=${generated.summary.model ?? 'n/a'}`,
    );
  }

  // =========================================================
  // RESPONSE SHAPERS
  // =========================================================

  private async buildResponseFromPersisted(
    trip: TripWithRelations,
    tripIdLabel: string,
    items: PersistedChecklistItem[],
    generatedBy: ChecklistGeneratedBy,
  ): Promise<GeneratedChecklist> {
    const context = this.buildTripContext(trip);

    const normalized: GeneratedChecklistItem[] = items.map((it) => ({
      id: it.id.toString(),
      title: it.title,
      description: it.description ?? undefined,
      memo: it.memo ?? undefined,
      categoryCode: it.category.code,
      categoryLabel: it.category.labelKo,
      prepType: it.prepType as GeneratedChecklistItem['prepType'],
      baggageType: it.baggageType as GeneratedChecklistItem['baggageType'],
      source: (it.source === ChecklistItemSource.template
        ? 'template'
        : it.source === ChecklistItemSource.llm
          ? 'llm'
          : 'user_added') as 'template' | 'llm' | 'user_added',
      isEssential: false,
      orderIndex: it.orderIndex,
      isSelected: it.isSelected,
      selectedAt: it.selectedAt ? it.selectedAt.toISOString() : null,
      isChecked: it.isChecked,
      scope: it.scope,
      assigneeUserId: it.assigneeUserId?.toString() ?? null,
    }));

    const fromTemplate = normalized.filter((i) => i.source === 'template').length;
    const fromLlm = normalized.filter((i) => i.source === 'llm').length;

    const sections = await this.groupIntoSections(normalized);

    return {
      tripId: tripIdLabel,
      context,
      summary: {
        total: normalized.length,
        fromTemplate,
        fromLlm,
        duplicatesRemoved: 0,
        llmTokensUsed: 0,
        model: null,
        cacheStatus: 'db-cached',
      },
      sections,
      items: normalized,
    };
    // generatedBy 는 현재 응답에 굳이 노출하지 않지만, 향후 디버그 필드로 추가 고려.
    void generatedBy;
  }

  private async groupIntoSections(items: GeneratedChecklistItem[]) {
    const categoryOrder = await this.prisma.checklistCategory.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    const sectionMap = new Map<
      string,
      { categoryCode: string; categoryLabel: string; items: GeneratedChecklistItem[] }
    >();
    for (const cat of categoryOrder) {
      sectionMap.set(cat.code, { categoryCode: cat.code, categoryLabel: cat.labelKo, items: [] });
    }
    for (const item of items) {
      if (!sectionMap.has(item.categoryCode)) {
        sectionMap.set(item.categoryCode, {
          categoryCode: item.categoryCode,
          categoryLabel: item.categoryLabel,
          items: [],
        });
      }
      sectionMap.get(item.categoryCode)!.items.push(item);
    }
    return Array.from(sectionMap.values()).filter((s) => s.items.length > 0);
  }

  // =========================================================
  // PERSISTENCE HELPERS
  // =========================================================

  private async loadTripForContext(tripId: bigint): Promise<TripWithRelations> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      include: {
        country: true,
        cities: { include: { city: true }, orderBy: { orderIndex: 'asc' } },
        companions: { include: { companionType: true } },
        travelStyles: { include: { travelStyle: true } },
      },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    return trip;
  }

  async loadPersistedChecklistItems(tripId: bigint): Promise<{
    items: PersistedChecklistItem[];
    generatedBy: ChecklistGeneratedBy;
  } | null> {
    const checklist = await this.prisma.checklist.findUnique({
      where: { tripId },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: { orderIndex: 'asc' },
          include: { category: true },
        },
      },
    });
    if (!checklist) return null;
    return { items: checklist.items, generatedBy: checklist.generatedBy };
  }

  private inferGeneratedBy(generated: GeneratedChecklist): ChecklistGeneratedBy {
    const { fromLlm, fromTemplate } = generated.summary;
    if (fromLlm > 0 && fromTemplate > 0) return ChecklistGeneratedBy.hybrid;
    if (fromLlm > 0) return ChecklistGeneratedBy.llm;
    return ChecklistGeneratedBy.template;
  }

  // =========================================================
  // STATIC HELPERS
  // =========================================================

  /** 중복 판별을 위한 타이틀 정규화. 공백/대소문자/구두점을 무시. */
  private normalizeTitle(title: string): string {
    return title
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[.,/·\-()[\]{}]/g, '');
  }

  /** "다른 물건"으로 인정하는 접미사 — 본체와 액세서리 구분 (예: 여권 vs 여권 케이스) */
  private static readonly DEDUP_ACCESSORY_SUFFIXES = [
    '케이스', '커버', '지갑', '파우치', '홀더', '스트랩', '가방', '주머니', '목걸이',
  ];

  /** 비교 전에 제거하는 수식어 — "소화 보조제 추가분" → "소화보조제" */
  private static readonly DEDUP_MODIFIERS = ['추가분', '여분', '예비', '휴대용', '미니', '세트', '추가'];

  /**
   * 시스템 프롬프트의 [절대 추천 금지] 목록과 같은 근거의 어간(stem).
   * LLM 항목 제목에 이 어간이 포함되면 기본 준비물과 같은 목적으로 보고 드랍한다.
   * ("소화보조제"처럼 비연속 변형이라 부분 포함 검사로 못 잡는 케이스 방어)
   */
  private static readonly DEDUP_BANNED_STEMS = [
    '소화', '감기', '해열', '지사', '멀미', '연고', '밴드', '반창고',
    '선크림', '선스틱', '자외선차단', '충전', '보조배터리', '멀티어댑터',
    '칫솔', '치약', '샴푸', '여권', '환전', '여행자보험',
  ];

  /**
   * LLM 항목의 유사 중복 판정 — 정규화 키 기준으로 한쪽이 다른 쪽을 포함하면 같은 항목.
   * 예) "소화보조제" ⊃ "소화제" → 중복.
   * 오탐 가드:
   *   - 포함당하는 키가 3글자 미만이면 검사 제외 ("약" ⊂ "감기약" 같은 과잉 매칭 방지)
   *   - 나머지 문자열이 액세서리 접미사면 다른 물건으로 인정 ("여권케이스" ⊅ "여권")
   */
  private isVariantOfExisting(key: string, seenKeys: Set<string>): boolean {
    // 0) 수식어 제거 ("소화보조제추가분" → "소화보조제")
    let stripped = key;
    for (const m of ChecklistsService.DEDUP_MODIFIERS) {
      stripped = stripped.replaceAll(m, '');
    }

    // 1) 금지 어간 — 기본 준비물과 같은 목적이면 드랍 (비연속 변형까지 방어)
    //    단, 액세서리 접미사가 붙은 형태(여권 케이스 등)는 다른 물건으로 인정
    const hasAccessorySuffix = ChecklistsService.DEDUP_ACCESSORY_SUFFIXES.some((s) =>
      stripped.includes(s),
    );
    if (!hasAccessorySuffix) {
      if (ChecklistsService.DEDUP_BANNED_STEMS.some((stem) => stripped.includes(stem))) {
        return true;
      }
    }

    // 2) 기존 키와의 부분 포함 검사 (소화보조제 ⊃ 소화제 류의 연속 변형)
    for (const existing of seenKeys) {
      const [shorter, longer] =
        existing.length <= stripped.length ? [existing, stripped] : [stripped, existing];
      if (shorter.length < 3) continue;
      if (!longer.includes(shorter)) continue;
      const remainder = longer.replace(shorter, '');
      if (
        ChecklistsService.DEDUP_ACCESSORY_SUFFIXES.some((s) => remainder.includes(s))
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  /** DB 의 ChecklistItemTemplate(countryId=null 공통분) 을 GeneratedChecklistItem 형태로 로드. */
  private async loadTemplateItems(): Promise<GeneratedChecklistItem[]> {
    const templates = await this.prisma.checklistItemTemplate.findMany({
      where: { countryId: null },
      include: { category: true },
      orderBy: [{ category: { sortOrder: 'asc' } }, { id: 'asc' }],
    });
    return templates.map((t, idx) => ({
      id: null,
      title: t.title,
      description: t.description ?? undefined,
      categoryCode: t.category.code,
      categoryLabel: t.category.labelKo,
      prepType: t.prepType as GeneratedChecklistItem['prepType'],
      baggageType: t.baggageType as GeneratedChecklistItem['baggageType'],
      source: 'template' as const,
      isEssential: t.isEssential,
      orderIndex: idx,
      isSelected: false,
      selectedAt: null,
      isChecked: false,
      scope: 'personal' as const,
    }));
  }

  /** Trip 레코드로부터 OpenAI 프롬프트용 컨텍스트 조립. */
  private buildTripContext(trip: TripWithRelations): TripContext {
    const durationDays = Math.max(
      1,
      Math.round(
        (trip.tripEnd.getTime() - trip.tripStart.getTime()) / (1000 * 60 * 60 * 24),
      ) + 1,
    );

    const cityList = trip.cities
      .map((c) => c.city?.nameKo ?? c.customCityName ?? '')
      .filter(Boolean)
      .join(', ');
    const destination = cityList ? `${trip.country.nameKo} (${cityList})` : trip.country.nameKo;

    const companions: string[] = trip.companions.map((c) => c.companionType.labelKo);
    if (trip.companions.some((c) => c.hasPet)) companions.push('반려동물');

    const purposes = trip.travelStyles.map((s) => s.travelStyle.labelKo);

    return {
      destination,
      durationDays,
      season: this.inferSeason(trip.tripStart),
      travelMonth: trip.tripStart.getMonth() + 1,
      companions,
      purposes,
    };
  }

  /** 월(month)로부터 북반구 기준 계절 추정. (간단 휴리스틱) */
  private inferSeason(date: Date): string {
    const month = date.getMonth() + 1;
    if (month >= 3 && month <= 5) return '봄';
    if (month >= 6 && month <= 8) return '여름';
    if (month >= 9 && month <= 11) return '가을';
    return '겨울';
  }
}
