import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BaggageType,
  CheckAction,
  ChecklistGeneratedBy,
  ChecklistItemSource,
  ChecklistStatus,
  EditType,
  LlmStatus,
  PrepType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  OpenaiService,
  TripContext,
  ReclassifyInputItem,
  ReclassifiedItem,
} from '../llm/openai.service';
import type {
  UpsertItemDto,
  EditItemDto,
} from './dto/upsert-items.dto';

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
  /** 사용자가 체크(완료)했는지. 후보 풀에서는 의미 없음. */
  isChecked: boolean;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenaiService,
  ) {}

  // =========================================================
  // READ
  // =========================================================

  /**
   * "내 체크리스트" 조회 — isSelected=true 인 아이템만 GeneratedChecklist 형태로 반환.
   * 후보 풀 전체(미선택 포함)가 필요하면 listCandidatesForTrip 를 사용.
   */
  async getByTrip(tripId: bigint): Promise<GeneratedChecklist> {
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
    return this.buildResponseFromPersisted(
      trip,
      tripId.toString(),
      checklist.items,
      checklist.generatedBy,
    );
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
   * Trip 이 DB 에 없는 경우에도 돌릴 수 있는 컨텍스트 기반 생성.
   * - persist 는 수행하지 않는다 (tripId 가 없으므로 ChecklistItem 을 저장할 위치가 없음).
   * - Phase 3 이후로는 프론트가 항상 먼저 Trip 을 만들고 `/generate/:tripId` 를 쓰는 것이 권장 경로.
   */
  async generateFromContext(
    context: TripContext,
    opts?: { tripIdLabel?: string },
  ): Promise<GeneratedChecklist> {
    return this.buildGeneratedChecklist(context, opts?.tripIdLabel ?? 'context');
  }

  // =========================================================
  // SELECT / DESELECT (candidate pool → my checklist)
  // =========================================================

  async selectItem(itemId: bigint): Promise<PersistedChecklistItem> {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException(`ChecklistItem ${itemId} not found`);
    return this.prisma.checklistItem.update({
      where: { id: itemId },
      data: { isSelected: true, selectedAt: new Date() },
      include: { category: true },
    });
  }

  async deselectItem(itemId: bigint): Promise<PersistedChecklistItem> {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException(`ChecklistItem ${itemId} not found`);
    return this.prisma.checklistItem.update({
      where: { id: itemId },
      data: { isSelected: false, selectedAt: null },
      include: { category: true },
    });
  }

  // =========================================================
  // UPSERT / EDIT / DELETE / CHECK (영속화 + 로그)
  // =========================================================

  /**
   * 체크리스트 아이템 일괄 upsert.
   *
   *   - 기준: (checklistId, 정규화된 title, deletedAt=null) 로 매칭.
   *   - 매칭되는 기존 아이템이 있으면 description/prepType/baggageType/orderIndex 를 덮어쓴다.
   *   - 매칭 없는 신규 아이템은 `ChecklistItem` 로 INSERT 하고
   *     `source` 는 DTO 값을 그대로 쓴다 (`user_added` 가 가장 많을 것).
   *   - Checklist 레코드가 아직 없으면 새로 만들어 준다 (`generatedBy: template`).
   *   - 각 신규/수정 건은 `ChecklistItemEdit` 로그(`add` / `text`)에 남긴다 — userId 필수.
   *
   * @returns 저장 후의 전체 아이템 목록(후보 풀)과 요약 메트릭.
   */
  async upsertItems(
    tripId: bigint,
    userId: bigint,
    items: UpsertItemDto[],
  ) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      select: { id: true },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);

    const categories = await this.prisma.checklistCategory.findMany();
    const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));
    const fallbackCategory =
      categories.find((c) => c.code === 'ai_recommend') ?? categories[0];

    const { createdIds, updatedIds } = await this.prisma.$transaction(async (tx) => {
      // Checklist 보장 (generate 를 돌리지 않은 상태에서도 upsert 가능하도록).
      let checklist = await tx.checklist.findUnique({ where: { tripId } });
      if (!checklist) {
        checklist = await tx.checklist.create({
          data: {
            tripId,
            generatedBy: ChecklistGeneratedBy.template,
            status: 'not_started',
          },
        });
      }

      const existing = await tx.checklistItem.findMany({
        where: { checklistId: checklist.id, deletedAt: null },
      });
      const existingByKey = new Map(
        existing.map((e) => [this.normalizeTitle(e.title), e]),
      );

      const created: bigint[] = [];
      const updated: bigint[] = [];

      for (const input of items) {
        const key = this.normalizeTitle(input.title);
        const match = existingByKey.get(key);
        const categoryId =
          categoryIdByCode.get(input.categoryCode) ?? fallbackCategory?.id;
        if (!categoryId) {
          throw new Error('[upsertItems] seed 된 ChecklistCategory 가 없습니다.');
        }

        if (match) {
          const changed =
            match.description !== (input.description ?? null) ||
            match.prepType !== (input.prepType as PrepType) ||
            match.baggageType !== (input.baggageType as BaggageType) ||
            match.orderIndex !== input.orderIndex ||
            !match.isSelected;

          if (!changed) continue;

          const before = {
            title: match.title,
            description: match.description,
            prepType: match.prepType,
            baggageType: match.baggageType,
            orderIndex: match.orderIndex,
          };

          const after = {
            title: input.title,
            description: input.description ?? null,
            prepType: input.prepType,
            baggageType: input.baggageType,
            orderIndex: input.orderIndex,
          };

          await tx.checklistItem.update({
            where: { id: match.id },
            data: {
              description: input.description ?? null,
              prepType: input.prepType as PrepType,
              baggageType: input.baggageType as BaggageType,
              orderIndex: input.orderIndex,
              isSelected: true,
              selectedAt: new Date(),
            },
          });

          await tx.checklistItemEdit.create({
            data: {
              itemId: match.id,
              userId,
              editType:
                match.orderIndex !== input.orderIndex
                  ? EditType.reorder
                  : EditType.text,
              beforeValue: before as Prisma.InputJsonValue,
              afterValue: after as Prisma.InputJsonValue,
            },
          });
          updated.push(match.id);
        } else {
          const mapSource = (s: UpsertItemDto['source']): ChecklistItemSource => {
            if (s === 'template') return ChecklistItemSource.template;
            if (s === 'llm') return ChecklistItemSource.llm;
            return ChecklistItemSource.user_added;
          };

          const createdItem = await tx.checklistItem.create({
            data: {
              checklistId: checklist.id,
              categoryId,
              title: input.title,
              description: input.description ?? null,
              prepType: input.prepType as PrepType,
              baggageType: input.baggageType as BaggageType,
              source: mapSource(input.source),
              orderIndex: input.orderIndex,
              isSelected: true,
              selectedAt: new Date(),
            },
          });
          await tx.checklistItemEdit.create({
            data: {
              itemId: createdItem.id,
              userId,
              editType: EditType.add,
              afterValue: {
                title: createdItem.title,
                source: createdItem.source,
                orderIndex: createdItem.orderIndex,
              } as Prisma.InputJsonValue,
            },
          });
          created.push(createdItem.id);
        }
      }

      return { createdIds: created, updatedIds: updated };
    }, { timeout: 10000, maxWait: 5000 });

    this.logger.log(
      `[upsertItems] trip=${tripId} user=${userId} created=${createdIds.length} updated=${updatedIds.length}`,
    );

    const allItems = await this.prisma.checklistItem.findMany({
      where: {
        checklist: { tripId },
        deletedAt: null,
      },
      orderBy: { orderIndex: 'asc' },
      include: { category: true },
    });

    return {
      ok: true as const,
      tripId: tripId.toString(),
      persistedCount: allItems.length,
      createdCount: createdIds.length,
      updatedCount: updatedIds.length,
      items: allItems.map((it) => this.serializeItem(it)),
    };
  }

  /**
   * 단일 아이템 편집 (title / description / orderIndex).
   *
   *   - 변경 전·후 값을 `ChecklistItemEdit` 에 남긴다.
   *   - 어떤 필드가 바뀌었는지에 따라 editType 결정:
   *       · orderIndex 만 바뀜 → `reorder`
   *       · 그 외                → `text`
   *   - 실제로 바뀐 필드가 없으면 업데이트 생략 + 로그 생략 (no-op).
   */
  async editItem(itemId: bigint, userId: bigint, patch: EditItemDto) {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
      include: { category: true },
    });
    if (!item) throw new NotFoundException(`ChecklistItem ${itemId} not found`);

    const patchedTitle = patch.title ?? item.title;
    const patchedDesc = patch.description !== undefined ? patch.description : item.description;
    const patchedMemo = patch.memo !== undefined ? patch.memo : item.memo;
    const patchedOrder = patch.orderIndex ?? item.orderIndex;

    const titleChanged = patch.title !== undefined && patch.title !== item.title;
    const descChanged =
      patch.description !== undefined && (patch.description ?? null) !== (item.description ?? null);
    const memoChanged =
      patch.memo !== undefined && (patch.memo ?? null) !== (item.memo ?? null);
    const orderChanged =
      patch.orderIndex !== undefined && patch.orderIndex !== item.orderIndex;

    if (!titleChanged && !descChanged && !memoChanged && !orderChanged) {
      // no-op — 현재 상태 그대로 돌려준다.
      return {
        ok: true as const,
        itemId: item.id.toString(),
        changed: false,
        item: this.serializeItem(item),
      };
    }

    const before = {
      title: item.title,
      description: item.description,
      memo: item.memo,
      orderIndex: item.orderIndex,
    };
    const after = {
      title: patchedTitle,
      description: patchedDesc ?? null,
      memo: patchedMemo ?? null,
      orderIndex: patchedOrder,
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      // clientUpdatedAt 이 있으면 낙관적 락 적용 — updatedAt 불일치 시 충돌로 간주.
      const where: Prisma.ChecklistItemWhereInput = {
        id: itemId,
        deletedAt: null,
        ...(patch.clientUpdatedAt && {
          updatedAt: new Date(patch.clientUpdatedAt),
        }),
      };

      const result = await tx.checklistItem.updateMany({
        where,
        data: {
          title: patchedTitle,
          description: patchedDesc ?? null,
          memo: patchedMemo ?? null,
          orderIndex: patchedOrder,
        },
      });

      if (result.count === 0) {
        throw new ConflictException(
          '다른 사용자가 이미 수정했습니다. 최신 데이터를 다시 조회하세요.',
        );
      }

      await tx.checklistItemEdit.create({
        data: {
          itemId,
          userId,
          editType:
            !titleChanged && !descChanged && !memoChanged && orderChanged
              ? EditType.reorder
              : EditType.text,
          beforeValue: before as Prisma.InputJsonValue,
          afterValue: after as Prisma.InputJsonValue,
        },
      });

      return tx.checklistItem.findFirst({
        where: { id: itemId },
        include: { category: true },
      });
    }, { timeout: 10000, maxWait: 5000 });

    this.logger.log(
      `[editItem] item=${itemId} user=${userId} titleChanged=${titleChanged} descChanged=${descChanged} memoChanged=${memoChanged} orderChanged=${orderChanged}`,
    );

    return {
      ok: true as const,
      itemId: itemId.toString(),
      changed: true,
      item: this.serializeItem(updated!),
    };
  }

  /**
   * 단일 아이템 소프트 삭제.
   *
   *   - deletedAt 을 now() 로 찍고, `ChecklistItemEdit(editType='del')` 로그 남김.
   *   - 이미 삭제된 아이템이면 NotFound (soft deleted 포함).
   */
  async deleteItem(itemId: bigint, userId: bigint) {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
      include: {
        checklist: {
          include: { trip: { select: { userId: true } } },
        },
      },
    });
    if (!item) throw new NotFoundException('항목을 찾을 수 없습니다.');
    if (item.checklist.trip.userId !== userId) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.checklistItem.update({
        where: { id: itemId },
        data: { deletedAt: now },
      }),
      this.prisma.checklistItemEdit.create({
        data: {
          itemId,
          userId,
          editType: EditType.del,
          beforeValue: {
            title: item.title,
            description: item.description,
            orderIndex: item.orderIndex,
          } as Prisma.InputJsonValue,
        },
      }),
    ]);

    this.logger.log(`[deleteItem] item=${itemId} user=${userId}`);

    return {
      ok: true as const,
      itemId: itemId.toString(),
      deletedAt: now.toISOString(),
      message: '항목이 삭제되었습니다.',
    };
  }

  /**
   * 체크 토글 (checked / unchecked).
   *
   *   - isChecked / checkedAt 갱신 + `ChecklistItemCheck` 로그.
   *   - 이미 원하는 상태면 로그는 남기지만 update 는 no-op 처리.
   */
  async toggleCheck(
    itemId: bigint,
    userId: bigint,
    action: 'checked' | 'unchecked',
  ) {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException(`ChecklistItem ${itemId} not found`);

    const now = new Date();
    const desired = action === 'checked';
    const shouldUpdate = item.isChecked !== desired;

    const { completionRate, newStatus } = await this.prisma.$transaction(async (tx) => {
      // 1. isChecked 갱신
      if (shouldUpdate) {
        await tx.checklistItem.update({
          where: { id: itemId },
          data: {
            isChecked: desired,
            checkedAt: desired ? now : null,
          },
        });
      }

      // 2. 체크 로그 기록
      await tx.checklistItemCheck.create({
        data: {
          itemId,
          userId,
          action: action === 'checked' ? CheckAction.checked : CheckAction.unchecked,
        },
      });

      // 3. 갱신 후 최신 진행률 계산 및 Checklist.status / completionRate 업데이트
      const checklist = await tx.checklist.findFirst({
        where: { id: item.checklistId },
        include: {
          items: {
            where: { isSelected: true, deletedAt: null },
            select: { isChecked: true },
          },
        },
      });

      const total = checklist?.items.length ?? 0;
      const checked = checklist?.items.filter((i) => i.isChecked).length ?? 0;
      const completionRate = total === 0 ? 0 : (checked / total) * 100;
      const newStatus: ChecklistStatus =
        completionRate === 0
          ? ChecklistStatus.not_started
          : completionRate >= 100
          ? ChecklistStatus.completed
          : ChecklistStatus.preparing;

      if (shouldUpdate) {
        await tx.checklist.update({
          where: { id: item.checklistId },
          data: { status: newStatus, completionRate },
        });
      }

      return { completionRate, newStatus };
    }, { timeout: 10000, maxWait: 5000 });

    this.logger.log(
      `[toggleCheck] item=${itemId} user=${userId} action=${action} updated=${shouldUpdate} rate=${completionRate.toFixed(2)}% status=${newStatus}`,
    );

    return {
      ok: true as const,
      itemId: itemId.toString(),
      action,
      isChecked: desired,
      checkedAt: desired ? now.toISOString() : null,
      occurredAt: now.toISOString(),
    };
  }

  // =========================================================
  // RECLASSIFY (가이드 보관함 항목 재분류)
  // =========================================================

  /**
   * 가이드 보관함 항목들을 LLM 으로 재분류한다.
   * - persist 하지 않는다 (refinedCategory/refinedSubCategory 는 프론트의 보관함 스냅샷 필드).
   * - LLM 호출 자체가 실패하면(API key 미설정 등) `{ items: [], model: null }` 로 폴백 — 프론트가 fallback 처리.
   */
  async reclassifyGuideArchive(
    items: ReclassifyInputItem[],
  ): Promise<{ items: ReclassifiedItem[]; model: string | null }> {
    if (!items || items.length === 0) {
      return { items: [], model: null };
    }
    try {
      const { items: refined, usage } = await this.openai.reclassifyGuideArchiveItems(items);
      this.logger.log(
        `[reclassifyGuideArchive] in=${items.length} out=${refined.length} tokens=${usage.tokens}`,
      );
      return { items: refined, model: usage.model };
    } catch (e) {
      this.logger.error(`[reclassifyGuideArchive] LLM call failed: ${(e as Error).message}`);
      return { items: [], model: null };
    }
  }

  /**
   * 영속화된 ChecklistItem (+category) 를 프론트 응답 형태로 직렬화.
   */
  private serializeItem(it: PersistedChecklistItem): GeneratedChecklistItem {
    return {
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
    };
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

      const { items, usage } = await this.openai.recommendAdditionalItems(context);
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
        } satisfies GeneratedChecklistItem;
      });
    } catch (e) {
      this.logger.error(
        `[buildGeneratedChecklist] LLM call failed (trip=${tripIdLabel}): ${(e as Error).message}`,
      );
    }

    // --- 3) 중복 제거 (template 우선, LLM 은 같은 title 이면 버림) ---
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
    llmItems.forEach(pushIfUnique);

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

  private async loadPersistedChecklistItems(tripId: bigint): Promise<{
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

    const cityList = trip.cities.map((c) => c.city.nameKo).join(', ');
    const destination = cityList ? `${trip.country.nameKo} (${cityList})` : trip.country.nameKo;

    const companions: string[] = trip.companions.map((c) => c.companionType.labelKo);
    if (trip.companions.some((c) => c.hasPet)) companions.push('반려동물');

    const purposes = trip.travelStyles.map((s) => s.travelStyle.labelKo);

    return {
      destination,
      durationDays,
      season: this.inferSeason(trip.tripStart),
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
