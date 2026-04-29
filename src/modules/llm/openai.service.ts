import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

const VALID_CATEGORIES = [
  'essentials',
  'clothing',
  'health',
  'toiletries',
  'beauty',
  'electronics',
  'travel_goods',
  'booking',
  'pre_departure',
] as const;

/**
 * 사용자의 여행 컨텍스트.
 * OpenAI 프롬프트에 그대로 직렬화되어 삽입된다.
 */
export interface TripContext {
  /** 목적지 (국가명 / 도시 리스트) */
  destination: string;
  /** 여행 기간(일) */
  durationDays: number;
  /** 계절 (봄/여름/가을/겨울 또는 tripStart 기반 자동 추정값) */
  season: string;
  /** 동반자 라벨 배열 (예: ["친구", "반려동물"]) — 빈 배열이면 혼자 */
  companions: string[];
  /** 여행 목적(스타일) 배열 (예: ["맛집 탐방", "쇼핑"]) */
  purposes: string[];
}

/**
 * OpenAI 가 반환하는 '추가 물품' 1건.
 *
 * - category: 서비스 카테고리 코드. 유효하지 않은 category 값이 오면 `travel_goods`로 fallback.
 *   유효 값: essentials | clothing | health | toiletries | beauty |
 *            electronics | travel_goods | booking | pre_departure
 * - prep_type / baggage_type: Prisma enum 값과 1:1 매핑.
 */
export interface AdditionalItem {
  title: string;
  category: string;
  description?: string;
  prep_type: 'item' | 'pre_booking' | 'pre_departure_check';
  baggage_type: 'carry_on' | 'checked' | 'none';
}

export interface AdditionalItemsResponse {
  items: AdditionalItem[];
}

/**
 * 가이드 보관함 항목 재분류 입력 — base category 가 있어도 좋고 없어도 됨.
 */
export interface ReclassifyInputItem {
  id: string;
  title: string;
  description?: string;
  detail?: string;
  category?: string;
  prepType?: string;
  subCategory?: string;
}

/**
 * 재분류 결과 — 프론트의 `refinedCategory` / `refinedSubCategory` 슬롯에 그대로 들어간다.
 */
export interface ReclassifiedItem {
  id: string;
  category: string;
  subCategory?: string;
  confidence?: number;
}

interface ReclassifyResponse {
  items: ReclassifiedItem[];
}

@Injectable()
export class OpenaiService {
  private readonly logger = new Logger(OpenaiService.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): OpenAI {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('llm.apiKey');
    if (!apiKey) {
      throw new Error(
        'LLM_API_KEY 가 설정되지 않았습니다. .env 에 OpenAI API Key 를 넣어주세요.',
      );
    }
    this.client = new OpenAI({ apiKey, timeout: 15_000 });
    return this.client;
  }

  /**
   * 여행 컨텍스트를 바탕으로 "기본 체크리스트에 없는 추가 물품"만 추천받는다.
   *
   * - 모델: gpt-4o-mini (env: LLM_MODEL)
   * - 출력: response_format=json_object 로 JSON 강제
   * - 기본 항목(여권/항공권/기본 옷/세면도구/상비약/충전기 등)은 DB 에서 이미 제공하므로
   *   프롬프트에 "절대 중복 추천 금지" 를 명시한다.
   */
  async recommendAdditionalItems(
    context: TripContext,
  ): Promise<{ items: AdditionalItem[]; usage: { tokens: number; model: string } }> {
    const model = this.config.get<string>('llm.model', 'gpt-4o-mini');
    const client = this.getClient();

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(context);

    this.logger.log(`[openai] request model=${model} destination=${context.destination}`);

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{"items":[]}';
    const parsed = this.safeParseResponse(raw);

    const items = parsed.items
      .filter((i) => typeof i?.title === 'string' && i.title.trim().length > 0)
      .map<AdditionalItem>((i) => ({
        title: i.title.trim(),
        category: VALID_CATEGORIES.includes(i.category as (typeof VALID_CATEGORIES)[number])
          ? (i.category as AdditionalItem['category'])
          : 'travel_goods',
        description: i.description?.toString().trim() || undefined,
        prep_type: (['item', 'pre_booking', 'pre_departure_check'] as const).includes(
          i.prep_type as AdditionalItem['prep_type'],
        )
          ? (i.prep_type as AdditionalItem['prep_type'])
          : 'item',
        baggage_type: (['carry_on', 'checked', 'none'] as const).includes(
          i.baggage_type as AdditionalItem['baggage_type'],
        )
          ? (i.baggage_type as AdditionalItem['baggage_type'])
          : 'carry_on',
      }));

    this.logger.log(
      `[openai] done items=${items.length} tokens=${completion.usage?.total_tokens ?? 0}`,
    );

    return {
      items,
      usage: {
        tokens: completion.usage?.total_tokens ?? 0,
        model,
      },
    };
  }

  /**
   * 가이드 보관함 항목들을 더 세분화된 카테고리/서브카테고리로 재분류한다.
   *
   *   - 입력: 기존 base `category` 와 함께 항목들의 title/description/detail.
   *   - 출력: id 별로 정제된 `category`(VALID_CATEGORIES 중 하나) + 자유 텍스트 `subCategory`(예: "전자기기/충전",
   *     "의류/방한") + 0~1 사이 `confidence`.
   *   - LLM 호출 실패/JSON 파싱 실패 시 빈 items[] 로 폴백 → 프론트 측은 기존 category 를 유지.
   */
  async reclassifyGuideArchiveItems(
    inputs: ReclassifyInputItem[],
  ): Promise<{ items: ReclassifiedItem[]; usage: { tokens: number; model: string } }> {
    if (inputs.length === 0) {
      return {
        items: [],
        usage: { tokens: 0, model: this.config.get<string>('llm.model', 'gpt-4o-mini') },
      };
    }

    const model = this.config.get<string>('llm.model', 'gpt-4o-mini');
    const client = this.getClient();

    const systemPrompt = this.buildReclassifySystemPrompt();
    const userPrompt = this.buildReclassifyUserPrompt(inputs);

    this.logger.log(`[openai:reclassify] request model=${model} count=${inputs.length}`);

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{"items":[]}';
    const parsed = this.safeParseReclassifyResponse(raw);

    // id 가 입력에 존재하는 것만 살리고, category 는 VALID_CATEGORIES 로 정규화.
    const inputIds = new Set(inputs.map((i) => i.id));
    const items = parsed.items
      .filter((row) => row && typeof row.id === 'string' && inputIds.has(row.id))
      .map<ReclassifiedItem>((row) => {
        const fallbackCategory =
          inputs.find((i) => i.id === row.id)?.category?.trim() || 'travel_goods';
        const category =
          typeof row.category === 'string' &&
          VALID_CATEGORIES.includes(row.category as (typeof VALID_CATEGORIES)[number])
            ? row.category
            : VALID_CATEGORIES.includes(fallbackCategory as (typeof VALID_CATEGORIES)[number])
              ? fallbackCategory
              : 'travel_goods';
        const subCategory =
          typeof row.subCategory === 'string' && row.subCategory.trim().length > 0
            ? row.subCategory.trim().slice(0, 64)
            : undefined;
        const confidence =
          typeof row.confidence === 'number' && Number.isFinite(row.confidence)
            ? Math.max(0, Math.min(1, row.confidence))
            : undefined;
        return { id: row.id, category, subCategory, confidence };
      });

    this.logger.log(
      `[openai:reclassify] done items=${items.length}/${inputs.length} tokens=${completion.usage?.total_tokens ?? 0}`,
    );

    return {
      items,
      usage: {
        tokens: completion.usage?.total_tokens ?? 0,
        model,
      },
    };
  }

  // -------------------------------------------------------
  // Prompt builders
  // -------------------------------------------------------
  private buildSystemPrompt(): string {
    return [
      '당신은 한국인 여행자를 위한 준비물 큐레이터입니다.',
      '기본 체크리스트에는 없지만 이 여행에서 진짜 빛나는 "킥 아이템"만 골라내는 것이 당신의 역할입니다.',
      '',
      '[절대 추천 금지 — 기본 체크리스트에 이미 있는 항목]',
      '여권/여권 복사본/항공권, 여벌옷/속옷/잠옷/양말/편한 신발/모자/선글라스,',
      '칫솔/치약/샴푸/린스/바디워시/클렌징/면봉/면도기,',
      '감기약/해열제/지사제/소화제/연고/밴드,',
      '보조배터리/충전기/멀티어댑터/이어폰,',
      '스킨/로션/자외선차단제, 휴지/물티슈/우산/비닐봉투,',
      '항공권 예약/숙소 예약/여행자보험/환전/여권 만료일 확인/온라인 체크인',
      '',
      '[추천 기준 — 세 가지 조건 중 하나 이상을 충족해야 추천 가능]',
      '① 동반자 전용: 이 동반자 구성이 아니면 필요 없는 물품',
      '   예) 반려동물 → 국제 건강증명서·펫캐리어 / 영유아 → 휴대용 물컵·기저귀 처리 봉투',
      '   예) 친구 그룹 → 무선 블루투스 스피커 / 연인·허니문 → 수중 카메라',
      '② 여행 목적 전용: 이 목적 없이는 짐에 넣을 이유가 없는 물품',
      '   예) 서핑 → 래시가드·아쿠아슈즈·방수팩 / 스키 → 핫팩·고글·넥워머',
      '   예) 클럽·나이트라이프 → 귀마개·소형 크로스백 / 하이킹 → 트레킹 폴·발수건',
      '   예) 미식·맛집 → 소화 보조제(현지 음식 대비)·음식 사진 조명 클립',
      '③ 목적지 특유 필수품: 이 목적지·계절 조합이 아니면 안 챙길 것',
      '   예) 동남아 우기 → 모기 기피제·방수 파우치 / 일본 겨울 → 아이젠·핫팩',
      '   예) 중동·이슬람권 → 가리개 스카프 / 고산지대 → 고산병 예방약',
      '',
      '[품질 기준]',
      '- 뻔한 항목 금지: "카메라", "선크림", "편한 신발" 같은 누구나 아는 것은 내지 마세요.',
      '- 각 항목의 description은 "왜 이 여행에 특히 필요한지" 한 문장으로 구체적으로 쓰세요.',
      '- 최대 12개. 12개를 채우려고 억지로 넣지 마세요. 진짜 필요한 것만.',
      '',
      '[category 분류 기준 — 반드시 아래 9개 중 하나를 선택]',
      'essentials   : 여행 필수 서류·결제수단 등 (여권, 항공권, 카드, 현금 등)',
      'clothing     : 의류·신발·액세서리',
      'health       : 의약품·건강 관련 용품',
      'toiletries   : 세면·위생용품',
      'beauty       : 화장품·미용기기·헤어용품',
      'electronics  : 전자기기·충전·통신 관련',
      'travel_goods : 여행 편의용품 (가방, 파우치, 잠금장치 등)',
      'booking      : 출발 전 예약·신청이 필요한 사항 (투어, 유심, 보험, 환전 등)',
      'pre_departure: 출국 당일 또는 직전 반드시 확인해야 할 사항',
      '',
      'prep_type과 category는 독립적으로 판단하세요.',
      '예) 여행자 보험 → category: booking / prep_type: pre_booking',
      '예) 여권 만료일 확인 → category: pre_departure / prep_type: pre_departure_check',
      '예) 모기 기피제 → category: health / prep_type: item',
      '',
      '[출력 JSON 형식 — 이 구조만 허용]',
      '{',
      '  "items": [',
      '    {',
      '      "title": "모기 기피제 (DEET 30% 이상)",',
      '      "description": "방콕 우기 야외 활동 시 뎅기열 매개 모기 차단 필수",',
      '      "category": "health",',
      '      "prep_type": "item",',
      '      "baggage_type": "carry_on"',
      '    }',
      '  ]',
      '}',
      '',
      'category: essentials | clothing | health | toiletries | beauty | electronics | travel_goods | booking | pre_departure',
      'prep_type: item | pre_booking | pre_departure_check',
      'baggage_type: carry_on | checked | none',
      '반드시 유효한 JSON만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.',
    ].join('\n');
  }

  private buildUserPrompt(ctx: TripContext): string {
    const companions = ctx.companions.length ? ctx.companions.join(', ') : '혼자';
    const purposes = ctx.purposes.length ? ctx.purposes.join(', ') : '일반 관광';
    return [
      '[사용자 여행 컨텍스트]',
      `- 목적지: ${ctx.destination}`,
      `- 여행 기간: ${ctx.durationDays}일`,
      `- 계절: ${ctx.season}`,
      `- 동반자: ${companions}`,
      `- 여행 목적: ${purposes}`,
      '',
      '위 컨텍스트에 맞는 "기본 체크리스트에 없는 추가 준비물"을 JSON 으로 추천해주세요.',
    ].join('\n');
  }

  private safeParseResponse(raw: string): AdditionalItemsResponse {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        return parsed as AdditionalItemsResponse;
      }
      this.logger.warn('[openai] response missing items[] — fallback to empty');
      return { items: [] };
    } catch (e) {
      this.logger.error(`[openai] JSON parse failed: ${(e as Error).message} raw=${raw.slice(0, 200)}`);
      return { items: [] };
    }
  }

  private buildReclassifySystemPrompt(): string {
    return [
      '당신은 한국인 여행자의 짐 보관함 항목을 더 세분화된 카테고리로 재분류하는 분류기입니다.',
      '',
      '[1차 카테고리 — 반드시 아래 9개 중 하나]',
      'essentials   : 여행 필수 서류·결제수단 등',
      'clothing     : 의류·신발·액세서리',
      'health       : 의약품·건강 관련 용품',
      'toiletries   : 세면·위생용품',
      'beauty       : 화장품·미용기기·헤어용품',
      'electronics  : 전자기기·충전·통신 관련',
      'travel_goods : 여행 편의용품 (가방, 파우치, 잠금장치 등)',
      'booking      : 출발 전 예약·신청이 필요한 사항',
      'pre_departure: 출국 당일/직전 확인 사항',
      '',
      '[서브카테고리]',
      '- 1차 카테고리 안에서 사용자에게 보여줄 짧은 한국어 라벨 (예: "충전/케이블", "방한", "상비약").',
      '- 8자 이내, 슬래시(/)는 1개까지 허용.',
      '- 명확하지 않으면 생략 가능 (필드 자체를 빼거나 빈 문자열).',
      '',
      '[confidence]',
      '- 0~1 사이의 숫자. 카테고리·서브카테고리 모두에 대한 자신감.',
      '',
      '[출력 JSON — 이 구조만 허용]',
      '{',
      '  "items": [',
      '    { "id": "<입력 id 그대로>", "category": "electronics", "subCategory": "충전/케이블", "confidence": 0.92 }',
      '  ]',
      '}',
      '입력에 없는 id 는 생성 금지. 각 입력 id 는 정확히 한 번씩만 응답하세요.',
      '반드시 유효한 JSON만 출력하세요.',
    ].join('\n');
  }

  private buildReclassifyUserPrompt(items: ReclassifyInputItem[]): string {
    const lines: string[] = [
      '[재분류 대상 항목]',
      '아래 항목들의 1차 카테고리와 서브카테고리를 정해 주세요. base_category 가 비어있거나 어색하면 다시 정해도 됩니다.',
      '',
    ];
    items.forEach((it) => {
      const desc = (it.description ?? '').trim();
      const detail = (it.detail ?? '').trim();
      lines.push(
        [
          `- id: ${it.id}`,
          `  title: ${it.title}`,
          desc ? `  description: ${desc}` : '',
          detail ? `  detail: ${detail}` : '',
          `  base_category: ${(it.category ?? '').trim() || '(미정)'}`,
          it.subCategory ? `  hint_subcategory: ${it.subCategory}` : '',
          it.prepType ? `  prep_type: ${it.prepType}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });
    return lines.join('\n');
  }

  private safeParseReclassifyResponse(raw: string): ReclassifyResponse {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        return parsed as ReclassifyResponse;
      }
      this.logger.warn('[openai:reclassify] response missing items[] — fallback to empty');
      return { items: [] };
    } catch (e) {
      this.logger.error(
        `[openai:reclassify] JSON parse failed: ${(e as Error).message} raw=${raw.slice(0, 200)}`,
      );
      return { items: [] };
    }
  }
}
