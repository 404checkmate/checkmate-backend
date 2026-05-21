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
    this.client = new OpenAI({ apiKey, timeout: 20_000, maxRetries: 0 });
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

    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(context);

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
      max_tokens: 800,
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
  private buildSystemPrompt(ctx: TripContext): string {
    return `당신은 한국인 여행자를 위한 실전 여행 준비 큐레이터입니다.
기본 체크리스트(여권, 항공권, 상비약, 충전기 등 일반적인 준비물)에는 없지만
이 여행에서 실질적으로 필요한 "킥 아이템"만 골라내는 것이 역할입니다.

[절대 추천 금지 — 기본 체크리스트에 이미 있는 항목]
여권/여권복사본/항공권, 여벌옷/속옷/잠옷/양말/편한신발/모자/선글라스,
칫솔/치약/샴푸/린스/바디워시/클렌징/면봉/면도기,
감기약/해열제/지사제/소화제/연고/밴드,
보조배터리/충전기/멀티어댑터/이어폰,
스킨/로션/자외선차단제, 휴지/물티슈/우산/비닐봉투,
항공권예약/숙소예약/여행자보험/환전/여권만료일확인/온라인체크인

[이 여행의 핵심 컨텍스트]
${this.buildContextSection(ctx)}

[추천 필수 포함 영역 — 아래 카테고리를 반드시 검토하고 해당하는 것만 포함]

## 현지 결제 수단
- 현지 QR결제 앱 (예: 알리페이, WeChat Pay, 페이페이, PromptPay, GCash 등 국가별)
- 수수료 우대 해외 결제 카드 (트래블월렛, 트래블로그, 하나 GLN 등)
- 현지 ATM 출금 한도 및 수수료 구조 확인 항목
→ 현금 사용 비율이 높은 국가 / QR 결제 발달 국가에 따라 선별

## 현지 이동 수단
- 택시 앱 (Grab, Gojek, Bolt, inDrive, DiDi, Uber, Lyft 등 국가별)
- 대중교통 카드 (교통카드 구입 필요 여부, 충전 방법)
- 렌터카/오토바이 렌트 시 국제면허증 필요 여부
- 특수 교통 (뚝뚝, 썽태우, 릭샤 등 현지 교통수단)
→ 국가/도시 특성에 맞는 항목만 선별

## 현지 디지털 인프라
- 지도 앱 (구글맵 사용 불가 국가: 중국→가오더/바이두, 러시아→얀덱스 등)
- 현지 주요 메신저 (LINE: 일본/태국, WeChat: 중국, WhatsApp: 동남아/유럽/중동)
- 번역 앱 (파파고, 구글번역 오프라인 팩 다운로드)
→ 국가별 디지털 환경에 맞게 선별

${this.buildVpnSection(ctx)}

## 기후/날씨 대응
${this.buildWeatherSection(ctx)}

## 여행 스타일별 특화 준비물
${this.buildStyleSection(ctx.purposes)}

## 동행 유형별 특화 준비물
${this.buildCompanionSection(ctx.companions)}

${this.buildVisaSection(ctx)}

${this.buildFoodAppSection(ctx)}

[추천 품질 기준]
- 뻔한 항목 절대 금지: 누구나 아는 것은 내지 않음
- 각 항목의 description은 "왜 이 여행/이 국가/이 시즌에 특히 필요한지" 한 문장으로 구체적으로
- 최대 15개. 15개를 채우려고 억지로 넣지 말 것. 진짜 필요한 것만.
- 국가명, 앱명, 서비스명을 구체적으로 명시할 것

[category 분류 기준 — 반드시 아래 9개 중 하나를 선택]
essentials   : 여행 필수 서류·결제수단 등 (여권, 항공권, 카드, 현금 등)
clothing     : 의류·신발·액세서리
health       : 의약품·건강 관련 용품
toiletries   : 세면·위생용품
beauty       : 화장품·미용기기·헤어용품
electronics  : 전자기기·충전·통신 관련
travel_goods : 여행 편의용품 (가방, 파우치, 잠금장치 등)
booking      : 출발 전 예약·신청이 필요한 사항 (투어, 유심, 보험, 환전 등)
pre_departure: 출국 당일 또는 직전 반드시 확인해야 할 사항

prep_type과 category는 독립적으로 판단하세요.
예) 여행자 보험 → category: booking / prep_type: pre_booking
예) 여권 만료일 확인 → category: pre_departure / prep_type: pre_departure_check
예) 모기 기피제 → category: health / prep_type: item

[출력 JSON 형식 — 이 구조만 허용]
{
  "items": [
    {
      "title": "Grab 앱 설치",
      "description": "태국 내 택시 바가지 방지 및 에어컨 차량 이용을 위해 필수",
      "category": "travel_goods",
      "prep_type": "item",
      "baggage_type": "none"
    }
  ]
}

category: essentials|clothing|health|toiletries|beauty|electronics|travel_goods|booking|pre_departure
prep_type: item|pre_booking|pre_departure_check
baggage_type: carry_on|checked|none
반드시 유효한 JSON만 출력. 다른 텍스트 절대 포함 금지.`.trim();
  }

  private buildContextSection(ctx: TripContext): string {
    const companions = ctx.companions.length > 0 ? ctx.companions.join(', ') : '혼자';
    const purposes = ctx.purposes.length > 0 ? ctx.purposes.join(', ') : '일반 관광';
    return [
      `목적지: ${ctx.destination}`,
      `여행 기간: ${ctx.durationDays}일`,
      `여행 시기: ${ctx.season} (${ctx.travelMonth}월) → 현지 기후 유추에 활용`,
      `동행: ${companions}`,
      `여행 스타일: ${purposes}`,
    ].join('\n');
  }

  private buildWeatherSection(ctx: TripContext): string {
    const { travelMonth: month, destination } = ctx;
    const hints: string[] = [];

    if (['태국', '베트남', '인도네시아', '필리핀', '말레이시아', '캄보디아'].some((c) => destination.includes(c))) {
      if (month >= 5 && month <= 10) {
        hints.push('- 우기: 방수 파우치, 방수 샌들, 속건 의류 → 갑작스러운 폭우 대비');
        hints.push('- 모기 기피제 (DEET 30% 이상): 우기 모기 활동 극성기');
      }
    }

    if (['일본', '중국', '독일', '프랑스', '영국', '이탈리아'].some((c) => destination.includes(c))) {
      if (month >= 11 || month <= 2) {
        hints.push('- 핫팩: 야외 관광 시 체온 유지 필수');
        hints.push('- 아이젠/미끄럼방지: 눈길/빙판 대비');
      }
    }

    if (['두바이', '아부다비', '카타르', '이집트', '모로코'].some((c) => destination.includes(c))) {
      hints.push('- 가리개 스카프: 이슬람 문화권 입장 시 + 강렬한 햇빛 차단');
      hints.push('- 전해질 보충제: 고온에서 탈수 방지');
    }

    if (['페루', '네팔', '티베트', '볼리비아', '에콰도르'].some((c) => destination.includes(c))) {
      hints.push('- 고산병 예방약 (다이아목스): 해발 2500m 이상 방문 시 필수');
      hints.push('- 고산병 증상 대비 산소 캔');
    }

    return hints.length > 0 ? hints.join('\n') : '- 특이 기후 이슈 없음, 일반 날씨 대비';
  }

  private buildStyleSection(purposes: string[]): string {
    const hasStyle = (keyword: string) => purposes.some((p) => p.includes(keyword));
    const hints: string[] = [];

    if (hasStyle('맛집') || hasStyle('미식') || hasStyle('음식')) {
      hints.push(
        '[맛집/미식 여행]\n' +
        '- 배달앱 (우버이츠/Talabat/Foodpanda/GrabFood): 숙소에서 현지 음식 탐방\n' +
        '- 식당 예약앱 (OpenTable, TheFork, 현지 앱): 인기 레스토랑 사전 예약\n' +
        '- 소화 보조제 추가분: 평소보다 훨씬 많이 먹게 됨\n' +
        '- 음식 사진 조명 클립: SNS용 음식 사진 품질 향상',
      );
    }

    if (hasStyle('쇼핑')) {
      hints.push(
        '[쇼핑 여행]\n' +
        '- 접이식 여행용 가방: 구매한 물건 수납용 추가 캐리어\n' +
        '- 캐리어 저울: 귀국 수하물 초과 요금 방지\n' +
        '- 면세 한도 초과 신고서: 600달러 초과 시 세관 신고 준비\n' +
        '- 진품 인증서 보관용 파일: 명품 구매 시 보증서 관리',
      );
    }

    if (hasStyle('액티비티') || hasStyle('서핑') || hasStyle('스킨스쿠버') || hasStyle('하이킹')) {
      hints.push(
        '[액티비티/스포츠]\n' +
        '- 방수팩: 수상 액티비티 시 스마트폰/지갑 보호\n' +
        '- 스포츠 여행자보험 별도 확인: 일반 여행보험은 익스트림 스포츠 미적용\n' +
        '- 아쿠아슈즈: 해변/암반 지형 대비\n' +
        '- 근육통 완화 파스/스프레이: 강도 높은 신체 활동 후 회복',
      );
    }

    if (hasStyle('포토') || hasStyle('사진') || hasStyle('인스타')) {
      hints.push(
        '[포토스팟/사진 여행]\n' +
        '- 미니 삼각대 or 고릴라포드: 혼자서도 인생샷 촬영\n' +
        '- 렌즈 클리너 키트: 습한 환경/먼지 많은 곳에서 렌즈 관리\n' +
        '- 여분 SD카드/클라우드 백업 설정: 사진 분실 방지\n' +
        '- ND필터: 밝은 환경에서 장노출 촬영',
      );
    }

    if (hasStyle('클럽') || hasStyle('나이트') || hasStyle('바')) {
      hints.push(
        '[나이트라이프]\n' +
        '- 귀마개 (소프트폼): 클럽 소음으로 인한 청각 보호\n' +
        '- 소형 크로스백: 클럽 내 소지품 분실 방지\n' +
        '- 여분 보조배터리 (소형): 밤새 사용 후 방전 대비',
      );
    }

    if (hasStyle('힐링') || hasStyle('휴양') || hasStyle('호캉스')) {
      hints.push(
        '[힐링/휴양]\n' +
        '- 넷플릭스/유튜브 오프라인 콘텐츠 다운로드: 리조트 와이파이 불안정 대비\n' +
        '- 독서용 전자책 리더기: 장시간 휴식 시 눈 피로 감소\n' +
        '- 수면 안대 + 귀마개 세트: 숙소 수면 질 향상',
      );
    }

    if (hasStyle('문화') || hasStyle('역사') || hasStyle('성지')) {
      hints.push(
        '[문화/역사/종교 탐방]\n' +
        '- 가리개 의류 (긴 소매/긴 바지): 성당/사원/모스크 입장 복장 규정\n' +
        '- 오디오 가이드 앱: 현지 박물관 한국어 해설\n' +
        '- 여분 보조배터리: 장시간 관람 중 지도/번역 앱 상시 사용',
      );
    }

    return hints.length > 0 ? hints.join('\n\n') : '- 일반 관광: 기본 준비물로 충분';
  }

  private buildVpnSection(ctx: TripContext): string {
    return `
## VPN 추천 기준 (매우 보수적으로 적용)

[VPN 추천 허용 국가 — 아래 국가만 추천]
- 중국: 구글/유튜브/인스타 등 차단 → VPN 없으면 인터넷 사실상 불가
- 러시아: 다수 서비스 차단
- 이란: 대부분 SNS/서비스 차단

[VPN 추천 금지 국가 — 아래 국가는 절대 VPN 추천 금지]
- 아랍에미리트(UAE): VPN 사용 불법, 적발 시 벌금/구금
- 카타르: VPN 사용 불법
- 오만: VPN 사용 불법
- 이라크: VPN 사용 불법
- 벨라루스: VPN 사용 불법
- 투르크메니스탄: VPN 사용 불법
- 북한: VPN 사용 불법

[그 외 모든 국가]
- VPN 추천 금지
- "보안을 위해 VPN을 사용하세요" 같은 일반적 권유 절대 금지

출력 형식 (VPN 추천 허용 국가에만 사용):
{
  "title": "VPN 앱 설치 (${ctx.destination} 필수)",
  "description": "${ctx.destination}에서는 구글/유튜브/카카오 등이 차단됨. 입국 전 ExpressVPN, NordVPN 등 설치 필수. 현지에서는 앱스토어 접근 불가",
  "category": "travel_goods",
  "prep_type": "item",
  "baggage_type": "none"
}`.trim();
  }

  private buildCompanionSection(companions: string[]): string {
    const hasCompanion = (keyword: string) => companions.some((c) => c.includes(keyword));
    const hints: string[] = [];

    if (hasCompanion('반려동물') || hasCompanion('펫')) {
      hints.push(
        '[반려동물 동반]\n' +
        '- 국제 동물 건강증명서 (KVIC): 입국 시 필수, 발급 2주 소요\n' +
        '- 반려동물 입국 가능 여부 사전 확인: 국가별 반입 제한 상이\n' +
        '- 펫 캐리어 (기내 반입용): 항공사별 규격 사전 확인\n' +
        '- 현지 동물병원 위치 사전 파악\n' +
        '- 사료 + 간식 충분량: 현지 구매 어려울 수 있음',
      );
    }

    if (hasCompanion('아이') || hasCompanion('영유아') || hasCompanion('유아')) {
      hints.push(
        '[영유아/아이 동반]\n' +
        '- 휴대용 유아 변기 시트: 현지 화장실 위생 대비\n' +
        '- 어린이 멀미약: 장거리 이동 대비 사전 처방\n' +
        '- 유아용 모기 기피 패치 (DEET 무함유): 어린이 안전 성분\n' +
        '- 유아 수영복 + 물놀이 완장\n' +
        '- 보온 재킷 (어린이): 기내 및 에어컨 강한 실내 대비\n' +
        '- 여분 옷 2벌 이상: 식사/물놀이 후 오염 대비',
      );
    }

    if (hasCompanion('부모님') || hasCompanion('부모') || hasCompanion('어르신')) {
      hints.push(
        '[부모님 동반]\n' +
        '- 해외 여행자 보험 의료비 한도 확인: 고령자 의료비 청구 높음\n' +
        '- 한국어 지원 여행앱 준비: 파파고 오프라인, 구글번역 오프라인\n' +
        '- 관절 보호대/압박 스타킹: 장거리 이동/장시간 도보 대비\n' +
        '- 비상 연락처 카드 (한국어+현지어): 미아 방지용\n' +
        '- 자외선 차단 암막 양산: 야외 활동 시 열사병 방지',
      );
    }

    if (hasCompanion('연인') || hasCompanion('허니문') || hasCompanion('커플')) {
      hints.push(
        '[연인/허니문]\n' +
        '- 수중 카메라 or 방수 케이스: 해변/수영장 커플 사진\n' +
        '- 커플 체험 예약 (스파, 다이닝): 인기 장소는 사전 예약 필수\n' +
        '- 여행 기념품 보관용 소형 파우치',
      );
    }

    if (hasCompanion('친구') || hasCompanion('그룹') || hasCompanion('단체')) {
      hints.push(
        '[친구/그룹 여행]\n' +
        '- 무선 블루투스 스피커: 숙소/해변에서 분위기 조성\n' +
        '- 여행 경비 정산앱 (Splitwise 등): 그룹 경비 투명하게 관리\n' +
        '- 단체용 여행자보험: 개별보다 저렴한 경우 있음',
      );
    }

    return hints.length > 0 ? hints.join('\n\n') : '';
  }

  private buildVisaSection(ctx: TripContext): string {
    return `
## 비자 및 입국 서류 (pre_departure_check 타입으로 추가)
아래 기준으로 ${ctx.destination} 방문에 필요한 비자/서류 항목을 반드시 검토할 것.

[한국 여권 소지자 기준으로 판단]
- 무비자 입국 가능 국가: 비자 불필요 → 입국카드, 세관신고서 등 도착 시 서류만 안내
- 도착비자(VOA) 가능 국가: 도착비자 신청 방법, 준비 서금액, 필요 서류 안내
- 사전 비자 필수 국가 (예: 중국, 인도, 러시아, 베트남 등):
  → 비자 종류(관광/전자비자/일반비자), 신청 방법, 소요 기간 안내
- 전자여행허가(ETA/ESTA) 필요 국가 (예: 미국 ESTA, 캐나다 eTA, 호주 ETA):
  → 신청 사이트, 비용, 유효기간 안내

출력 형식 예시:
{
  "title": "중국 비자 사전 발급",
  "description": "한국인은 중국 관광 시 사전 비자 필수. 대사관 또는 비자센터에서 발급, 보통 3~5 영업일 소요",
  "category": "pre_departure",
  "prep_type": "pre_departure_check",
  "baggage_type": "none"
}

{
  "title": "미국 ESTA 전자여행허가 신청",
  "description": "미국 입국 72시간 전 공식 사이트(esta.cbp.dhs.gov)에서 신청, $21, 2년 유효",
  "category": "pre_departure",
  "prep_type": "pre_departure_check",
  "baggage_type": "none"
}`.trim();
  }

  private buildFoodAppSection(ctx: TripContext): string {
    const hasFoodStyle = ctx.purposes.some(
      (p) => p.includes('맛집') || p.includes('미식') || p.includes('음식') || p.includes('먹방'),
    );

    if (!hasFoodStyle) return '';

    return `
## 맛집/식당 앱 추천 (travel_goods 타입으로 추가)
${ctx.destination} 여행 시 실제로 유용한 맛집/배달 앱을 국가별로 구체적으로 추천할 것.

[국가별 맛집/식당 앱 가이드]
- 일본: 타베로그(Tabelog), 구루나비(Gurunavi), 핫페퍼그루메(HotPepper Gourmet)
- 태국/동남아: GrabFood, Foodpanda, LINE MAN(태국)
- 중국: 다중뎬핑(大众点评), 메이퇀(美团)
- 미국/캐나다: Yelp, OpenTable, Resy
- 유럽: TheFork, TripAdvisor
- 호주: Zomato, DoorDash
- 중동: Talabat, Deliveroo
- 인도: Zomato, Swiggy
- 전세계 공통: Google Maps(맛집 검색), TripAdvisor

출력 형식 예시:
{
  "title": "타베로그(Tabelog) 앱 설치",
  "description": "일본 최대 맛집 리뷰 앱. 평점 3.5 이상이면 현지인도 인정하는 맛집. 한국어 지원",
  "category": "travel_goods",
  "prep_type": "item",
  "baggage_type": "none"
}

주의:
- 앱 이름과 특징을 구체적으로 명시할 것
- 해당 국가에서 실제로 많이 쓰는 앱만 추천
- 무료/유료 여부, 한국어 지원 여부 포함하면 더 좋음`.trim();
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
