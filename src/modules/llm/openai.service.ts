import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

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
 * - category: 서비스 카테고리 코드. 존재하지 않는 코드가 오면 호출부에서 ai_recommend 로 대체.
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
 * 허용되는 카테고리 코드 — 시드에 등록된 값과 동일.
 * (프롬프트에 나열해 LLM 이 이 값들 중에서만 고르도록 강제)
 */
const ALLOWED_CATEGORIES = [
  'essentials',
  'clothing',
  'health',
  'toiletries',
  'beauty',
  'electronics',
  'travel_goods',
  'booking',
  'pre_departure',
  'ai_recommend',
] as const;

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
    this.client = new OpenAI({ apiKey });
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
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{"items":[]}';
    const parsed = this.safeParseResponse(raw);

    // 카테고리 유효성 보정
    const items = parsed.items
      .filter((i) => typeof i?.title === 'string' && i.title.trim().length > 0)
      .map<AdditionalItem>((i) => ({
        title: i.title.trim(),
        category: (ALLOWED_CATEGORIES as readonly string[]).includes(i.category)
          ? i.category
          : 'ai_recommend',
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

  // -------------------------------------------------------
  // Prompt builders
  // -------------------------------------------------------
  private buildSystemPrompt(): string {
    return [
      '당신은 한국인을 위한 여행 준비물 전문가입니다.',
      '사용자의 여행 컨텍스트(목적지, 여행 기간, 계절, 동반자, 여행 목적)에 맞는',
      '"추가 준비 물품"을 추천하는 것이 당신의 역할입니다.',
      '',
      '[매우 중요 - 반드시 지켜야 할 규칙]',
      '1. 기본적인 여행 용품(여권, 여권 복사본, 항공권, 기본 옷(여벌옷/속옷/잠옷/양말/편한신발/모자/선글라스),',
      '   세면도구(칫솔/치약/샴푸/린스/바디워시/클렌징/면봉/면도기), 상비약(감기약/해열제/지사제/소화제/연고/밴드),',
      '   전자기기 기본(보조배터리/충전기/해외 멀티 어댑터/이어폰), 미용 기본(스킨/로션/자외선차단제),',
      '   기본 여행용품(휴지/물티슈/양우산/비닐봉투), 사전 예약(항공권/숙소/여행자보험/환전),',
      '   출국 전 확인(여권 만료일/온라인 체크인/수하물 규정) 등)은 이미 서비스의',
      '   기본 체크리스트에서 제공됩니다. 이런 항목은 **절대 다시 추천하지 마세요.**',
      '2. 대신, 사용자의 특정 상황(목적지 기후/문화, 계절, 동반자 구성, 여행 목적)에 **특별히 필요한 추가 물품만**',
      '   구체적으로 추천하세요.',
      '3. 예시:',
      '   - "방콕, 우기, 친구와 관광" → "휴대용 선풍기", "모기 기피제", "방수 파우치"',
      '   - "홋카이도, 겨울, 가족여행(아이 포함)" → "휴대용 핫팩", "미끄럼 방지 아이젠", "어린이용 장갑"',
      '   - "발리, 서핑" → "래시가드", "아쿠아슈즈", "물놀이 방수팩"',
      '4. 각 항목은 반드시 아래 카테고리 중 하나로 분류하세요:',
      `   ${ALLOWED_CATEGORIES.join(' | ')}`,
      '   - essentials: 필수 서류/금전 관련 특수 항목',
      '   - clothing: 계절/상황에 특화된 의류',
      '   - health: 특수 상황용 의료/건강 용품',
      '   - toiletries / beauty: 특수 목적의 위생/미용 용품',
      '   - electronics: 특수 전자기기',
      '   - travel_goods: 일반 여행 편의 용품',
      '   - booking: 추가 사전 예약/신청 항목',
      '   - pre_departure: 출국 전 특수 확인사항',
      '   - ai_recommend: 어느 카테고리에도 속하지 않는 항목',
      '5. 최대 10개까지만 추천하세요. 일반적이고 뻔한 항목보다 진짜 특정 상황에 유용한 것만.',
      '',
      '[출력 포맷 - 반드시 아래 JSON 구조로만 응답]',
      '{',
      '  "items": [',
      '    {',
      '      "title": "휴대용 선풍기",',
      '      "category": "electronics",',
      '      "description": "방콕 우기 습도와 더위 대비",',
      '      "prep_type": "item",',
      '      "baggage_type": "carry_on"',
      '    }',
      '  ]',
      '}',
      '',
      'prep_type 값: item | pre_booking | pre_departure_check',
      'baggage_type 값: carry_on | checked | none',
      '반드시 유효한 JSON 만 출력하고, 다른 텍스트는 절대 포함하지 마세요.',
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
}
