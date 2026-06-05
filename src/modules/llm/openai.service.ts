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
  /** 여행 출발 월 (1-12) — 기후 분기에 사용 */
  travelMonth: number;
  /** 동반자 라벨 배열 (예: ["친구", "반려동물"]) — 빈 배열이면 혼자 */
  companions: string[];
  /** 여행 목적(스타일) 배열 (예: ["맛집 탐방", "쇼핑"]) */
  purposes: string[];
}

/**
 * OpenAI 가 반환하는 '추가 물품' 1건.
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

export interface ReclassifyInputItem {
  id: string;
  title: string;
  description?: string;
  detail?: string;
  category?: string;
  prepType?: string;
  subCategory?: string;
}

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
    this.client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
    return this.client;
  }

  /**
   * 여행 컨텍스트를 바탕으로 "기본 체크리스트에 없는 추가 물품"만 추천받는다.
   *
   * 프롬프트 구조:
   *  - system: 역할·금지 목록·카테고리 가이드·출력 형식 — 완전 정적 (캐시 최대화)
   *  - user:   여행 컨텍스트 + 조건부 힌트 (날씨/VPN/비자/스타일/동행) — 동적
   */
  async recommendAdditionalItems(
    context: TripContext,
    existingTitles: string[] = [],
  ): Promise<{ items: AdditionalItem[]; usage: { tokens: number; model: string } }> {
    const model = this.config.get<string>('llm.model', 'gpt-4o-mini');
    const client = this.getClient();

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(context, existingTitles);

    this.logger.log(`[openai] request model=${model} destination=${context.destination}`);

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.5,
      max_tokens: 1500,
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
   * 가이드 보관함 항목들을 세분화된 카테고리/서브카테고리로 재분류한다.
   * 20개 초과 시 배치를 최대 3개씩 병렬 처리해 응답 시간을 단축한다.
   */
  async reclassifyGuideArchiveItems(
    inputs: ReclassifyInputItem[],
  ): Promise<{ items: ReclassifiedItem[]; usage: { tokens: number; model: string } }> {
    const model = this.config.get<string>('llm.model', 'gpt-4o-mini');
    if (inputs.length === 0) {
      return { items: [], usage: { tokens: 0, model } };
    }

    const BATCH_SIZE = 20;
    const CONCURRENCY = 3;

    if (inputs.length > BATCH_SIZE) {
      const batches: ReclassifyInputItem[][] = [];
      for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
        batches.push(inputs.slice(i, i + BATCH_SIZE));
      }

      const allItems: ReclassifiedItem[] = [];
      let totalTokens = 0;

      // CONCURRENCY개 배치씩 병렬 처리
      for (let i = 0; i < batches.length; i += CONCURRENCY) {
        const group = batches.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          group.map((batch) => this.reclassifySingleBatch(batch, model)),
        );
        for (const res of settled) {
          if (res.status === 'fulfilled') {
            allItems.push(...res.value.items);
            totalTokens += res.value.usage.tokens;
          } else {
            this.logger.warn(`[openai:reclassify] batch failed: ${res.reason}`);
          }
        }
      }

      return { items: allItems, usage: { tokens: totalTokens, model } };
    }

    return this.reclassifySingleBatch(inputs, model);
  }

  private async reclassifySingleBatch(
    inputs: ReclassifyInputItem[],
    model: string,
  ): Promise<{ items: ReclassifiedItem[]; usage: { tokens: number; model: string } }> {
    const client = this.getClient();
    const systemPrompt = this.buildReclassifySystemPrompt();
    const userPrompt = this.buildReclassifyUserPrompt(inputs);

    this.logger.log(`[openai:reclassify] request model=${model} count=${inputs.length}`);

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{"items":[]}';
    const parsed = this.safeParseReclassifyResponse(raw);

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

    return { items, usage: { tokens: completion.usage?.total_tokens ?? 0, model } };
  }

  // -------------------------------------------------------
  // Prompt builders
  // -------------------------------------------------------

  /**
   * 완전 정적(static) 시스템 프롬프트.
   * 컨텍스트를 포함하지 않으므로 OpenAI 프롬프트 캐싱 대상이 된다.
   */
  private buildSystemPrompt(): string {
    return `당신은 한국인 여행자를 위한 실전 여행 준비 큐레이터입니다.
기본 체크리스트에 없지만 이 여행에서 실질적으로 필요한 "킥 아이템"만 골라내세요.

[절대 추천 금지 — 기본 체크리스트에 이미 있음]
여권/여권복사본/항공권, 여벌옷/속옷/잠옷/양말/편한신발/모자/선글라스,
칫솔/치약/샴푸/린스/바디워시/클렌징/면봉/면도기,
감기약/해열제/지사제/소화제/연고/밴드,
보조배터리/충전기/멀티어댑터/이어폰,
스킨/로션/자외선차단제, 휴지/물티슈/우산/비닐봉투,
항공권예약/숙소예약/여행자보험/환전/여권만료일확인/온라인체크인

[중요] 위 금지 목록과 "같은 목적·유사 기능"인 변형 표현도 전부 금지입니다.
예) 소화제 → 소화 보조제·정장제·유산균제 ❌ | 밴드 → 반창고·습윤밴드 ❌ | 충전기 → 충전 케이블 ❌ | 자외선차단제 → 선크림·선스틱 ❌
"추가분·여분·예비·휴대용·미니" 등을 붙인 변형도 금지입니다. 예) 소화 보조제 추가분 ❌, 여분 충전기 ❌
user 메시지에 [이미 포함된 항목] 목록이 오면 그것과도 동일하게 대조하세요.
출력 직전에 각 항목을 금지 목록·이미 포함된 항목과 의미 단위로 대조해, 겹치면 그 항목을 제외하고 출력하세요.

[검토 영역 — 해당하는 것만 포함]
1. 현지 결제수단 — QR결제앱(알리페이/WeChat/PromptPay/GCash 등), 수수료 우대 카드(트래블월렛·트래블로그 등), ATM
2. 이동수단 — 택시앱(Grab/Gojek/DiDi/Uber/Lyft 등), 교통카드, 특수 교통수단(뚝뚝·썽태우 등), 국제면허
3. 디지털인프라 — 지도앱(중국→가오더/바이두, 러시아→얀덱스), 메신저(LINE/WeChat/WhatsApp), 번역앱 오프라인팩
4. VPN — 허용국가(중국·러시아·이란)만 추천. 불법국가(UAE·카타르·오만·이라크·벨라루스·투르크메니스탄) 절대 금지. 그 외 국가도 금지
5. 기후·날씨 대응 — user 메시지의 기후 힌트 참고
6. 비자·입국서류 — user 메시지의 비자 안내 참고 (category: pre_departure, prep_type: pre_departure_check)
7. 여행 스타일 특화 — user 메시지의 스타일 힌트 참고
8. 동행 유형 특화 — user 메시지의 동행 힌트 참고
9. 맛집앱 — 음식 관련 스타일일 때만

[추천 품질 기준]
- 뻔한 항목 절대 금지
- description: 이 국가·시즌에 특히 필요한 이유를 한 문장으로 구체적으로
- 최대 15개, 진짜 필요한 것만
- 앱명·서비스명·국가명을 구체적으로 명시

[category — 반드시 9개 중 하나]
essentials | clothing | health | toiletries | beauty | electronics | travel_goods | booking | pre_departure
prep_type: item | pre_booking | pre_departure_check  ← category와 독립 판단
예) 여행보험 → booking / pre_booking | 여권만료확인 → pre_departure / pre_departure_check | 모기기피제 → health / item
baggage_type: carry_on | checked | none

[출력] 반드시 유효한 JSON만, 다른 텍스트 없이:
{"items":[{"title":"...","description":"...","category":"...","prep_type":"...","baggage_type":"..."}]}`.trim();
  }

  /**
   * 동적 사용자 프롬프트.
   * 여행 컨텍스트 + 조건부 힌트(날씨/VPN/비자/스타일/동행/맛집앱)를 포함한다.
   * 시스템 프롬프트에서 반복되는 정보는 제거해 총 토큰을 최소화한다.
   */
  private buildUserPrompt(ctx: TripContext, existingTitles: string[] = []): string {
    const companions = ctx.companions.length ? ctx.companions.join(', ') : '혼자';
    const purposes = ctx.purposes.length ? ctx.purposes.join(', ') : '일반 관광';

    const lines: string[] = [
      '[여행 정보]',
      `목적지: ${ctx.destination}`,
      `기간: ${ctx.durationDays}일`,
      `시기: ${ctx.season} (${ctx.travelMonth}월)`,
      `동행: ${companions}`,
      `여행 스타일: ${purposes}`,
    ];

    // 실제 DB 템플릿 항목을 그대로 전달 — 하드코딩 금지 목록과의 drift 방지
    if (existingTitles.length > 0) {
      lines.push(
        '',
        '[이미 포함된 항목 — 이것들과 같거나 유사한 목적의 항목은 절대 추천 금지]',
        existingTitles.join(', '),
      );
    }

    const weatherHint = this.buildWeatherHint(ctx);
    if (weatherHint) lines.push('', '[기후 힌트]', weatherHint);

    const vpnHint = this.buildVpnHint(ctx);
    if (vpnHint) lines.push('', '[VPN 안내]', vpnHint);

    const visaHint = this.buildVisaHint(ctx);
    if (visaHint) lines.push('', '[비자·입국 안내]', visaHint);

    const styleHint = this.buildStyleHints(ctx.purposes);
    if (styleHint) lines.push('', '[여행 스타일 힌트]', styleHint);

    const companionHint = this.buildCompanionHints(ctx.companions);
    if (companionHint) lines.push('', '[동행 힌트]', companionHint);

    const foodHint = this.buildFoodAppHint(ctx);
    if (foodHint) lines.push('', '[맛집앱 힌트]', foodHint);

    lines.push('', '위 여행에 맞는 추가 준비물을 JSON으로 추천해주세요.');

    return lines.join('\n');
  }

  // ── 조건부 힌트 빌더 ────────────────────────────────────────

  private buildWeatherHint(ctx: TripContext): string {
    const { travelMonth: m, destination: d } = ctx;
    const hints: string[] = [];

    if (['태국', '베트남', '인도네시아', '필리핀', '말레이시아', '캄보디아'].some((c) => d.includes(c))) {
      if (m >= 5 && m <= 10) {
        hints.push('- 우기: 방수 파우치·방수 샌들·속건 의류 필요');
        hints.push('- 모기 기피제 (DEET 30% 이상): 우기 모기 활동 극성기');
      }
    }

    if (['일본', '중국', '독일', '프랑스', '영국', '이탈리아'].some((c) => d.includes(c))) {
      if (m >= 11 || m <= 2) {
        hints.push('- 핫팩: 야외 관광 시 체온 유지');
        hints.push('- 아이젠/미끄럼방지: 눈길·빙판 대비');
      }
    }

    if (['두바이', '아부다비', '카타르', '이집트', '모로코'].some((c) => d.includes(c))) {
      hints.push('- 가리개 스카프: 이슬람 문화권 입장 + 강렬한 햇빛 차단');
      hints.push('- 전해질 보충제: 고온 탈수 방지');
    }

    if (['페루', '네팔', '티베트', '볼리비아', '에콰도르'].some((c) => d.includes(c))) {
      hints.push('- 고산병 예방약 (다이아목스): 해발 2500m 이상 필수');
      hints.push('- 산소 캔: 고산병 증상 대비');
    }

    return hints.join('\n');
  }

  private buildVpnHint(ctx: TripContext): string {
    const d = ctx.destination;
    const BLOCKED = ['중국', '러시아', '이란'];
    const ILLEGAL = ['UAE', '아랍에미리트', '카타르', '오만', '이라크', '벨라루스', '투르크메니스탄'];

    if (ILLEGAL.some((c) => d.includes(c))) {
      return `${d}는 VPN 사용 불법 국가입니다. VPN을 절대 추천하지 마세요.`;
    }
    if (BLOCKED.some((c) => d.includes(c))) {
      return `${d}는 구글/유튜브/인스타/카카오 등 주요 서비스가 차단됩니다. 입국 전 VPN 앱(ExpressVPN/NordVPN 등) 설치를 추천하세요. 현지에서는 앱스토어 접근 불가.`;
    }
    return '';
  }

  private buildVisaHint(ctx: TripContext): string {
    return `한국 여권 소지자 기준 ${ctx.destination} 입국 요건을 확인하세요. ` +
      `무비자/도착비자(VOA)/사전비자/ETA/ESTA 중 해당하는 항목과 신청 방법·소요 기간·비용을 안내해주세요.`;
  }

  private buildStyleHints(purposes: string[]): string {
    const has = (kw: string) => purposes.some((p) => p.includes(kw));
    const sections: string[] = [];

    if (has('맛집') || has('미식') || has('음식') || has('먹방')) {
      sections.push(
        '[맛집/미식]\n' +
        '- 배달앱(우버이츠/Talabat/Foodpanda/GrabFood): 숙소에서 현지 음식 탐방\n' +
        '- 식당 예약앱(OpenTable/TheFork): 인기 레스토랑 사전 예약\n' +
        '- 소화 보조제 추가분: 평소보다 많이 먹게 됨\n' +
        '- 음식 사진 조명 클립: SNS용 음식 사진 품질 향상',
      );
    }

    if (has('쇼핑')) {
      sections.push(
        '[쇼핑]\n' +
        '- 접이식 여행 가방: 구매한 물건 수납용\n' +
        '- 캐리어 저울: 귀국 수하물 초과 요금 방지\n' +
        '- 면세 한도 초과 신고서: 600달러 초과 시 세관 신고\n' +
        '- 진품 인증서 보관용 파일: 명품 구매 시 보증서 관리',
      );
    }

    if (has('액티비티') || has('서핑') || has('스킨스쿠버') || has('하이킹')) {
      sections.push(
        '[액티비티/스포츠]\n' +
        '- 방수팩: 수상 액티비티 시 스마트폰·지갑 보호\n' +
        '- 스포츠 여행자보험 별도 확인: 일반 보험은 익스트림 스포츠 미적용\n' +
        '- 아쿠아슈즈: 해변·암반 지형\n' +
        '- 근육통 완화 파스/스프레이',
      );
    }

    if (has('포토') || has('사진') || has('인스타')) {
      sections.push(
        '[포토/사진]\n' +
        '- 미니 삼각대(고릴라포드): 혼자서도 인생샷\n' +
        '- 렌즈 클리너 키트: 습한 환경·먼지 많은 곳\n' +
        '- 여분 SD카드/클라우드 백업: 사진 분실 방지\n' +
        '- ND필터: 밝은 환경 장노출 촬영',
      );
    }

    if (has('클럽') || has('나이트') || has('바')) {
      sections.push(
        '[나이트라이프]\n' +
        '- 귀마개(소프트폼): 클럽 소음 청각 보호\n' +
        '- 소형 크로스백: 소지품 분실 방지\n' +
        '- 소형 보조배터리: 밤새 사용 후 방전 대비',
      );
    }

    if (has('힐링') || has('휴양') || has('호캉스')) {
      sections.push(
        '[힐링/휴양]\n' +
        '- 넷플릭스/유튜브 오프라인 콘텐츠: 리조트 와이파이 불안정 대비\n' +
        '- 전자책 리더기: 장시간 휴식 시 눈 피로 감소\n' +
        '- 수면 안대 + 귀마개: 숙소 수면 질 향상',
      );
    }

    if (has('문화') || has('역사') || has('성지')) {
      sections.push(
        '[문화/역사/종교]\n' +
        '- 가리개 의류(긴 소매/긴 바지): 성당·사원·모스크 복장 규정\n' +
        '- 오디오 가이드 앱: 현지 박물관 한국어 해설\n' +
        '- 여분 보조배터리: 장시간 지도·번역 앱 사용',
      );
    }

    return sections.join('\n\n');
  }

  private buildCompanionHints(companions: string[]): string {
    const has = (kw: string) => companions.some((c) => c.includes(kw));
    const sections: string[] = [];

    if (has('반려동물') || has('펫')) {
      sections.push(
        '[반려동물 동반]\n' +
        '- 국제 동물 건강증명서(KVIC): 입국 시 필수, 발급 2주 소요\n' +
        '- 반려동물 입국 가능 여부 사전 확인\n' +
        '- 펫 캐리어(기내 반입용): 항공사별 규격 확인\n' +
        '- 사료 + 간식 충분량: 현지 구매 어려울 수 있음',
      );
    }

    if (has('아이') || has('영유아') || has('유아')) {
      sections.push(
        '[영유아/아이 동반]\n' +
        '- 휴대용 유아 변기 시트: 현지 화장실 위생\n' +
        '- 어린이 멀미약: 장거리 이동 대비 사전 처방\n' +
        '- 유아용 모기 기피 패치(DEET 무함유)\n' +
        '- 보온 재킷(어린이): 기내·에어컨 강한 실내 대비\n' +
        '- 여분 옷 2벌 이상: 식사·물놀이 오염 대비',
      );
    }

    if (has('부모님') || has('부모') || has('어르신')) {
      sections.push(
        '[부모님 동반]\n' +
        '- 해외 여행자보험 의료비 한도 확인: 고령자 의료비 높음\n' +
        '- 파파고/구글번역 오프라인 준비\n' +
        '- 관절 보호대/압박 스타킹: 장시간 도보 대비\n' +
        '- 비상 연락처 카드(한국어+현지어): 미아 방지\n' +
        '- 자외선 차단 암막 양산: 열사병 방지',
      );
    }

    if (has('연인') || has('허니문') || has('커플')) {
      sections.push(
        '[연인/허니문]\n' +
        '- 수중 카메라 or 방수 케이스: 해변·수영장 커플 사진\n' +
        '- 커플 체험 예약(스파·다이닝): 인기 장소 사전 예약 필수\n' +
        '- 여행 기념품 보관용 소형 파우치',
      );
    }

    if (has('친구') || has('그룹') || has('단체')) {
      sections.push(
        '[친구/그룹]\n' +
        '- 무선 블루투스 스피커: 숙소·해변 분위기 조성\n' +
        '- 경비 정산앱(Splitwise 등): 그룹 경비 투명 관리\n' +
        '- 단체용 여행자보험: 개별보다 저렴할 수 있음',
      );
    }

    return sections.join('\n\n');
  }

  private buildFoodAppHint(ctx: TripContext): string {
    const hasFoodStyle = ctx.purposes.some(
      (p) => p.includes('맛집') || p.includes('미식') || p.includes('음식') || p.includes('먹방'),
    );
    if (!hasFoodStyle) return '';

    return `${ctx.destination} 여행 시 실제로 많이 쓰는 맛집·배달 앱을 구체적으로 추천하세요.
참고 — 일본: 타베로그/구루나비, 태국/동남아: GrabFood/LINE MAN, 중국: 다중뎬핑/메이퇀,
미국/캐나다: Yelp/OpenTable, 유럽: TheFork, 중동: Talabat, 전세계: Google Maps/TripAdvisor`;
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
