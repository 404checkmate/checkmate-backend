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

    // AI 추천 항목은 모두 ai_recommend 카테고리로 고정
    const items = parsed.items
      .filter((i) => typeof i?.title === 'string' && i.title.trim().length > 0)
      .map<AdditionalItem>((i) => ({
        title: i.title.trim(),
        category: 'ai_recommend',
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
      '[출력 JSON 형식 — 이 구조만 허용]',
      '{',
      '  "items": [',
      '    {',
      '      "title": "모기 기피제 (DEET 30% 이상)",',
      '      "description": "방콕 우기 야외 활동 시 뎅기열 매개 모기 차단 필수",',
      '      "prep_type": "item",',
      '      "baggage_type": "carry_on"',
      '    }',
      '  ]',
      '}',
      '',
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
}
