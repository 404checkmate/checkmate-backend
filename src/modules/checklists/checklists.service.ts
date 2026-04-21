import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OpenaiService, TripContext } from '../llm/openai.service';

/**
 * 통합 체크리스트 응답에서 쓰이는 단일 아이템 형태.
 * (ChecklistItem 테이블에 INSERT 되기 전의 "가상 아이템" - 서비스 메모리에서만 존재)
 */
export interface GeneratedChecklistItem {
  title: string;
  description?: string;
  categoryCode: string;
  categoryLabel: string;
  prepType: 'item' | 'pre_booking' | 'pre_departure_check' | 'ai_recommend';
  baggageType: 'carry_on' | 'checked' | 'none';
  source: 'template' | 'llm';
  isEssential: boolean;
  orderIndex: number;
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
  };
  sections: Array<{
    categoryCode: string;
    categoryLabel: string;
    items: GeneratedChecklistItem[];
  }>;
  items: GeneratedChecklistItem[];
}

@Injectable()
export class ChecklistsService {
  private readonly logger = new Logger(ChecklistsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenaiService,
  ) {}

  async getByTrip(tripId: bigint) {
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
    if (!checklist) throw new NotFoundException(`Checklist for trip ${tripId} not found`);
    return checklist;
  }

  /**
   * 맞춤형 체크리스트 생성 (DB 기본 템플릿 + OpenAI 추가 추천을 통합).
   *
   * 1) Trip 정보를 조회하여 여행 컨텍스트(목적지/기간/계절/동반자/목적)를 구성
   * 2) DB 의 ChecklistItemTemplate 을 전부 로드 (countryId=null 인 공통 템플릿)
   * 3) OpenaiService 로 "추가 물품" JSON 추천 수신
   * 4) title 정규화 기반 중복 제거 후 카테고리별로 그룹핑하여 반환
   *
   * 현재 구현은 응답만 돌려주며 DB 에 ChecklistItem 을 INSERT 하지는 않는다.
   * (영속화는 별도 엔드포인트로 분리 — 필요 시 확장)
   */
  async generateForTrip(tripId: bigint): Promise<GeneratedChecklist> {
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

    const context = this.buildTripContext(trip);

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
          title: raw.title,
          description: raw.description,
          categoryCode: category?.code ?? 'ai_recommend',
          categoryLabel: category?.labelKo ?? 'AI 추천',
          prepType: raw.prep_type,
          baggageType: raw.baggage_type,
          source: 'llm' as const,
          isEssential: false,
          orderIndex: idx,
        };
      });
    } catch (e) {
      // LLM 실패 시에도 기본 템플릿은 응답에 포함되도록 graceful fallback.
      this.logger.error(`[generateForTrip] LLM call failed: ${(e as Error).message}`);
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

    // --- 4) 카테고리별 그룹핑 ---
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
    for (const item of merged) {
      if (!sectionMap.has(item.categoryCode)) {
        sectionMap.set(item.categoryCode, {
          categoryCode: item.categoryCode,
          categoryLabel: item.categoryLabel,
          items: [],
        });
      }
      sectionMap.get(item.categoryCode)!.items.push(item);
    }

    const sections = Array.from(sectionMap.values()).filter((s) => s.items.length > 0);

    return {
      tripId: trip.id.toString(),
      context,
      summary: {
        total: merged.length,
        fromTemplate: templateItems.length,
        fromLlm: llmItems.length,
        duplicatesRemoved,
        llmTokensUsed: llmUsage?.tokens ?? 0,
        model: llmUsage?.model ?? null,
      },
      sections,
      items: merged,
    };
  }

  // -------------------------------------------------------
  // helpers
  // -------------------------------------------------------

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
      title: t.title,
      description: t.description ?? undefined,
      categoryCode: t.category.code,
      categoryLabel: t.category.labelKo,
      prepType: t.prepType as GeneratedChecklistItem['prepType'],
      baggageType: t.baggageType as GeneratedChecklistItem['baggageType'],
      source: 'template' as const,
      isEssential: t.isEssential,
      orderIndex: idx,
    }));
  }

  /** Trip 레코드로부터 OpenAI 프롬프트용 컨텍스트 조립. */
  private buildTripContext(trip: {
    tripStart: Date;
    tripEnd: Date;
    country: { nameKo: string };
    cities: Array<{ city: { nameKo: string } }>;
    companions: Array<{ companionType: { labelKo: string }; hasPet: boolean }>;
    travelStyles: Array<{ travelStyle: { labelKo: string } }>;
  }): TripContext {
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
