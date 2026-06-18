/* eslint-disable no-console */
/**
 * Prisma Seed - 마스터 데이터 초기화
 *
 * 실행: `npm run prisma:seed`
 *
 * 포함:
 * - countries (ISO-3166 alpha-2)
 * - cities (주요 취항지)
 * - checklist_categories
 * - checklist_item_templates (기본 여행 준비물)
 * - travel_styles
 * - companion_types
 *
 * 모든 upsert는 idempotent — 여러 번 실행해도 안전합니다.
 */
import { PrismaClient, Prisma, PrepType, BaggageType } from '@prisma/client';

const prisma = new PrismaClient();

async function seedCountries() {
  const countries = [
    // 아시아
    { code: 'JP', nameKo: '일본', nameEn: 'Japan' },
    { code: 'VN', nameKo: '베트남', nameEn: 'Vietnam' },
    { code: 'CN', nameKo: '중국', nameEn: 'China' },
    { code: 'TH', nameKo: '태국', nameEn: 'Thailand' },
    { code: 'TW', nameKo: '대만', nameEn: 'Taiwan' },
    { code: 'SG', nameKo: '싱가포르', nameEn: 'Singapore' },
    { code: 'MY', nameKo: '말레이시아', nameEn: 'Malaysia' },
    { code: 'PH', nameKo: '필리핀', nameEn: 'Philippines' },
    { code: 'ID', nameKo: '인도네시아', nameEn: 'Indonesia' },
    { code: 'HK', nameKo: '홍콩', nameEn: 'Hong Kong' },
    { code: 'KH', nameKo: '캄보디아', nameEn: 'Cambodia' },
    // 태평양 (미국 자치령)
    { code: 'GU', nameKo: '괌', nameEn: 'Guam' },
    { code: 'MP', nameKo: '사이판', nameEn: 'Saipan (CNMI)' },
    // 아메리카
    { code: 'US', nameKo: '미국', nameEn: 'United States' },
    // 유럽
    { code: 'FR', nameKo: '프랑스', nameEn: 'France' },
    { code: 'IT', nameKo: '이탈리아', nameEn: 'Italy' },
    { code: 'ES', nameKo: '스페인', nameEn: 'Spain' },
    { code: 'GB', nameKo: '영국', nameEn: 'United Kingdom' },
    { code: 'CH', nameKo: '스위스', nameEn: 'Switzerland' },
    // 오세아니아
    { code: 'AU', nameKo: '호주', nameEn: 'Australia' },
  ];
  for (const c of countries) {
    await prisma.country.upsert({
      where: { code: c.code },
      update: { nameKo: c.nameKo, nameEn: c.nameEn },
      create: c,
    });
  }
  console.log(`[seed] countries: ${countries.length} rows upserted`);
}

async function seedCities() {
  const pairs: Array<{
    countryCode: string;
    nameKo: string;
    nameEn: string;
    iataCode: string | null;
    isServed: boolean;
  }> = [
    // 일본
    { countryCode: 'JP', nameKo: '후쿠오카', nameEn: 'Fukuoka', iataCode: 'FUK', isServed: true },
    { countryCode: 'JP', nameKo: '도쿄', nameEn: 'Tokyo', iataCode: 'NRT', isServed: true },
    { countryCode: 'JP', nameKo: '오사카', nameEn: 'Osaka', iataCode: 'KIX', isServed: true },
    { countryCode: 'JP', nameKo: '삿포로', nameEn: 'Sapporo', iataCode: 'CTS', isServed: true },
    { countryCode: 'JP', nameKo: '교토', nameEn: 'Kyoto', iataCode: null, isServed: true },
    { countryCode: 'JP', nameKo: '나고야', nameEn: 'Nagoya', iataCode: 'NGO', isServed: true },
    { countryCode: 'JP', nameKo: '오키나와', nameEn: 'Okinawa', iataCode: 'OKA', isServed: true },
    { countryCode: 'JP', nameKo: '유후인', nameEn: 'Yufuin', iataCode: null, isServed: true },
    { countryCode: 'JP', nameKo: '벳푸', nameEn: 'Beppu', iataCode: null, isServed: true },
    { countryCode: 'JP', nameKo: '나가사키', nameEn: 'Nagasaki', iataCode: 'NGS', isServed: true },
    { countryCode: 'JP', nameKo: '히로시마', nameEn: 'Hiroshima', iataCode: 'HIJ', isServed: true },
    { countryCode: 'JP', nameKo: '구마모토', nameEn: 'Kumamoto', iataCode: 'KMJ', isServed: true },
    // 베트남
    { countryCode: 'VN', nameKo: '다낭', nameEn: 'Da Nang', iataCode: 'DAD', isServed: true },
    { countryCode: 'VN', nameKo: '나트랑', nameEn: 'Nha Trang', iataCode: 'CXR', isServed: true },
    { countryCode: 'VN', nameKo: '하노이', nameEn: 'Hanoi', iataCode: 'HAN', isServed: true },
    { countryCode: 'VN', nameKo: '호찌민', nameEn: 'Ho Chi Minh City', iataCode: 'SGN', isServed: true },
    { countryCode: 'VN', nameKo: '푸꾸옥', nameEn: 'Phu Quoc', iataCode: 'PQC', isServed: true },
    { countryCode: 'VN', nameKo: '호이안', nameEn: 'Hoi An', iataCode: null, isServed: true },
    // 중국
    { countryCode: 'CN', nameKo: '상하이', nameEn: 'Shanghai', iataCode: 'PVG', isServed: true },
    { countryCode: 'CN', nameKo: '베이징', nameEn: 'Beijing', iataCode: 'PEK', isServed: true },
    { countryCode: 'CN', nameKo: '청두', nameEn: 'Chengdu', iataCode: 'CTU', isServed: true },
    { countryCode: 'CN', nameKo: '하이난', nameEn: 'Hainan', iataCode: 'SYX', isServed: true },
    { countryCode: 'CN', nameKo: '장가계', nameEn: 'Zhangjiajie', iataCode: 'DYG', isServed: true },
    { countryCode: 'CN', nameKo: '계림', nameEn: 'Guilin', iataCode: 'KWL', isServed: true },
    // 태국
    { countryCode: 'TH', nameKo: '방콕', nameEn: 'Bangkok', iataCode: 'BKK', isServed: true },
    { countryCode: 'TH', nameKo: '푸껫', nameEn: 'Phuket', iataCode: 'HKT', isServed: true },
    { countryCode: 'TH', nameKo: '치앙마이', nameEn: 'Chiang Mai', iataCode: 'CNX', isServed: true },
    { countryCode: 'TH', nameKo: '파타야', nameEn: 'Pattaya', iataCode: 'UTP', isServed: true },
    { countryCode: 'TH', nameKo: '코사무이', nameEn: 'Ko Samui', iataCode: null, isServed: true },
    // 미국
    { countryCode: 'US', nameKo: '하와이', nameEn: 'Hawaii', iataCode: 'HNL', isServed: true },
    { countryCode: 'US', nameKo: '로스앤젤레스', nameEn: 'Los Angeles', iataCode: 'LAX', isServed: true },
    { countryCode: 'US', nameKo: '뉴욕', nameEn: 'New York', iataCode: 'JFK', isServed: true },
    { countryCode: 'US', nameKo: '라스베이거스', nameEn: 'Las Vegas', iataCode: 'LAS', isServed: true },
    // 대만
    { countryCode: 'TW', nameKo: '타이베이', nameEn: 'Taipei', iataCode: 'TPE', isServed: true },
    { countryCode: 'TW', nameKo: '타이중', nameEn: 'Taichung', iataCode: 'RMQ', isServed: true },
    { countryCode: 'TW', nameKo: '가오슝', nameEn: 'Kaohsiung', iataCode: 'KHH', isServed: true },
    // 싱가포르
    { countryCode: 'SG', nameKo: '싱가포르', nameEn: 'Singapore', iataCode: 'SIN', isServed: true },
    // 말레이시아
    { countryCode: 'MY', nameKo: '쿠알라룸푸르', nameEn: 'Kuala Lumpur', iataCode: 'KUL', isServed: true },
    { countryCode: 'MY', nameKo: '코타키나발루', nameEn: 'Kota Kinabalu', iataCode: 'BKI', isServed: true },
    { countryCode: 'MY', nameKo: '페낭', nameEn: 'Penang', iataCode: 'PEN', isServed: true },
    // 괌
    { countryCode: 'GU', nameKo: '투몬', nameEn: 'Tumon', iataCode: 'GUM', isServed: true },
    // 사이판
    { countryCode: 'MP', nameKo: '사이판', nameEn: 'Saipan', iataCode: 'GSN', isServed: true },
    // 필리핀
    { countryCode: 'PH', nameKo: '세부', nameEn: 'Cebu', iataCode: 'CEB', isServed: true },
    { countryCode: 'PH', nameKo: '보라카이', nameEn: 'Boracay', iataCode: 'KLO', isServed: true },
    { countryCode: 'PH', nameKo: '마닐라', nameEn: 'Manila', iataCode: 'MNL', isServed: true },
    { countryCode: 'PH', nameKo: '팔라완', nameEn: 'Palawan', iataCode: 'PPS', isServed: true },
    // 인도네시아
    { countryCode: 'ID', nameKo: '발리', nameEn: 'Bali', iataCode: 'DPS', isServed: true },
    { countryCode: 'ID', nameKo: '자카르타', nameEn: 'Jakarta', iataCode: 'CGK', isServed: true },
    // 홍콩
    { countryCode: 'HK', nameKo: '홍콩', nameEn: 'Hong Kong', iataCode: 'HKG', isServed: true },
    // 캄보디아
    { countryCode: 'KH', nameKo: '시엠립', nameEn: 'Siem Reap', iataCode: 'REP', isServed: true },
    { countryCode: 'KH', nameKo: '프놈펜', nameEn: 'Phnom Penh', iataCode: 'PNH', isServed: true },
    // 프랑스
    { countryCode: 'FR', nameKo: '파리', nameEn: 'Paris', iataCode: 'CDG', isServed: true },
    // 이탈리아
    { countryCode: 'IT', nameKo: '로마', nameEn: 'Rome', iataCode: 'FCO', isServed: true },
    { countryCode: 'IT', nameKo: '밀라노', nameEn: 'Milan', iataCode: 'MXP', isServed: true },
    // 스페인
    { countryCode: 'ES', nameKo: '바르셀로나', nameEn: 'Barcelona', iataCode: 'BCN', isServed: true },
    { countryCode: 'ES', nameKo: '마드리드', nameEn: 'Madrid', iataCode: 'MAD', isServed: true },
    // 영국
    { countryCode: 'GB', nameKo: '런던', nameEn: 'London', iataCode: 'LHR', isServed: true },
    // 스위스
    { countryCode: 'CH', nameKo: '취리히', nameEn: 'Zurich', iataCode: 'ZRH', isServed: true },
    // 호주
    { countryCode: 'AU', nameKo: '시드니', nameEn: 'Sydney', iataCode: 'SYD', isServed: true },
    { countryCode: 'AU', nameKo: '멜버른', nameEn: 'Melbourne', iataCode: 'MEL', isServed: true },
    { countryCode: 'AU', nameKo: '브리즈번', nameEn: 'Brisbane', iataCode: 'BNE', isServed: true },
  ];

  for (const p of pairs) {
    const country = await prisma.country.findUnique({ where: { code: p.countryCode } });
    if (!country) {
      console.warn(`[seed] skip city ${p.nameKo}: country ${p.countryCode} not found`);
      continue;
    }

    // null iataCode 도시는 nameKo+country 조합으로 찾는다 (iataCode: null 단독 조회는 다른 null 도시를 잘못 매칭함).
    const existing = p.iataCode
      ? await prisma.city.findFirst({ where: { iataCode: p.iataCode } })
      : await prisma.city.findFirst({ where: { iataCode: null, nameKo: p.nameKo, country: { code: p.countryCode } } });

    if (existing) {
      await prisma.city.update({
        where: { id: existing.id },
        data: {
          countryId: country.id,
          nameKo: p.nameKo,
          nameEn: p.nameEn,
          iataCode: p.iataCode,
          isServed: p.isServed,
        },
      });
    } else {
      await prisma.city.create({
        data: {
          countryId: country.id,
          nameKo: p.nameKo,
          nameEn: p.nameEn,
          iataCode: p.iataCode,
          isServed: p.isServed,
        },
      });
    }
  }
  console.log(`[seed] cities: ${pairs.length} rows upserted`);
}

async function seedChecklistCategories() {
  // 서비스에서 제공하는 기본 체크리스트 섹션(9개) + 기존 카테고리
  const categories = [
    // 기본 제공 섹션 (sort 1~9)
    { code: 'essentials', labelKo: '필수 준비물', sortOrder: 1 },
    { code: 'clothing', labelKo: '입을 옷', sortOrder: 2 },
    { code: 'health', labelKo: '상비약', sortOrder: 3 },
    { code: 'toiletries', labelKo: '세면도구', sortOrder: 4 },
    { code: 'beauty', labelKo: '미용용품', sortOrder: 5 },
    { code: 'electronics', labelKo: '전자제품', sortOrder: 6 },
    { code: 'travel_goods', labelKo: '여행용품', sortOrder: 7 },
    { code: 'booking', labelKo: '사전 예약/신청', sortOrder: 8 },
    { code: 'pre_departure', labelKo: '출국 전 확인사항', sortOrder: 9 },
    // 기타
    { code: 'documents', labelKo: '서류', sortOrder: 90 },
    { code: 'packing', labelKo: '짐 꾸리기', sortOrder: 91 },
    { code: 'activity', labelKo: '액티비티', sortOrder: 92 },
    { code: 'ai_recommend', labelKo: 'AI 추천', sortOrder: 99 },
  ];
  for (const c of categories) {
    await prisma.checklistCategory.upsert({
      where: { code: c.code },
      update: { labelKo: c.labelKo, sortOrder: c.sortOrder },
      create: c,
    });
  }
  console.log(`[seed] checklist_categories: ${categories.length} rows upserted`);
}

// -------------------------------------------------------
// 기본 여행 준비물 템플릿
// -------------------------------------------------------
// ChecklistItemTemplate 은 countryId=null(=전세계 공통) + conditions={} 로 등록한다.
// 중복 방지는 (categoryCode, title) 조합으로 판별한다.
type TemplateSeed = {
  categoryCode: string;
  title: string;
  description?: string;
  prepType: PrepType;
  baggageType: BaggageType;
  isEssential?: boolean;
  /** 조건부 노출 — { countries: string[] }: destination에 해당 국가명 포함 시에만 추천 */
  conditions?: Prisma.InputJsonValue;
};

/** 열대 바다 국가 — 수영용품 등 해변 한정 항목의 노출 조건 */
const BEACH_COUNTRIES = ['괌', '사이판', '태국', '베트남', '필리핀', '인도네시아', '말레이시아', '캄보디아', '싱가포르'];

const DEFAULT_TEMPLATES: TemplateSeed[] = [
  // 필수 준비물
  { categoryCode: 'essentials', title: '항공권(e티켓 캡처, 출력본)', description: '탑승할 때 보여줘야 해서 미리 준비해두면 편해요', prepType: 'item', baggageType: 'none', isEssential: true },
  { categoryCode: 'essentials', title: '여권, 여권 복사본', description: '없으면 출국 불가! 복사본도 챙겨두면 더 안전해요', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '이심 / 유심 / 로밍 / 포켓 와이파이', description: '지도·번역·예약 앱 쓰려면 인터넷 필수예요', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '해외 결제 카드', description: '식당, 쇼핑, 교통까지 거의 다 카드로 해결돼요', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '약간의 현금', description: '카드 안 되는 곳이나 팁 줄 때 필요해요', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '볼펜', description: '비행기에서 서류 작성할 때 하나 있으면 좋아요', prepType: 'item', baggageType: 'carry_on' },

  // 입을 옷
  { categoryCode: 'clothing', title: '여벌옷', description: '땀 나거나 더러워질 상황 대비해서 챙겨요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '잠옷', description: '숙소에서 편하게 쉬려면 필요해요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '속옷', description: '매일 갈아입을 만큼은 꼭 챙겨요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '양말', description: '오래 걸을 때 발도 덜 피곤해요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '편한 신발', description: '여행은 생각보다 많이 걷게 돼요', prepType: 'item', baggageType: 'none' },
  { categoryCode: 'clothing', title: '모자', description: '햇빛 강할 때 있으면 훨씬 덜 힘들어요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'clothing', title: '선글라스', description: '눈 피로 줄이고 시야도 더 편해져요', prepType: 'item', baggageType: 'carry_on' },

  // 상비약
  { categoryCode: 'health', title: '감기약', description: '기내나 숙소 에어컨 때문에 감기 걸리기 쉬워요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '해열진통제', description: '두통이나 몸살 올 때 바로 대응 가능해요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '지사제', description: '음식 안 맞을 때 대비용이에요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '소화제', description: '여행 가면 평소보다 많이 먹게 돼요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '연고/소독약', description: '작은 상처나 벌레 물림 대비용이에요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '알콜스왑', description: '간단한 소독용으로 챙겨두면 좋아요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '밴드', description: '신발 쓸리거나 상처 났을 때 유용해요', prepType: 'item', baggageType: 'carry_on' },

  // 세면도구
  { categoryCode: 'toiletries', title: '칫솔, 치약', description: '숙소에 없는 경우도 많아요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '세안용품(클렌징폼, 클렌징오일, 립앤아이 리무버)', description: '평소 쓰던 거 쓰는 게 피부에 편해요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '샤워용품(샴푸, 린스, 바디워시)', description: '숙소 제품 안 맞을 수도 있어요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '면봉/화장솜', description: '세안 마무리나 화장 수정할 때 은근 자주 써요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '면도기/제모기', description: '여행 중에도 깔끔하게 관리해요', prepType: 'item', baggageType: 'checked' },

  // 미용용품
  { categoryCode: 'beauty', title: '스킨케어 (스킨, 로션, 립밤, 핸드크림)', description: '어디에서나 소중한 내 피부 지켜요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '자외선 차단제 (크림, 스틱, 스프레이)', description: '야외에 오래 있으면 금방 타요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '색조 화장품', description: '사진 많이 찍게 돼요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '헤어용품(머리끈, 머리핀, 헤어롤)', description: '머리 정리에 필요해요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '헤어제품 (에센스/오일/왁스/스프레이)', description: '완벽한 헤어스타일링을 도와줘요', prepType: 'item', baggageType: 'checked' },

  // 전자제품
  { categoryCode: 'electronics', title: '보조배터리', description: '밖에 있으면 배터리가 빨리 닳아요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'electronics', title: '충전기 (용도에 따라)', description: '휴대폰, 카메라 등 전자기기 충전에 필요해요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'electronics', title: '해외 멀티 어댑터', description: '나라별 콘센트 다 달라요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'electronics', title: '이어폰', description: '비행기나 이동할 때 있으면 좋아요', prepType: 'item', baggageType: 'carry_on' },

  // 여행용품
  { categoryCode: 'travel_goods', title: '휴대용 휴지, 물티슈', description: '없는 곳도 꽤 있어서 챙기는 게 편해요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'travel_goods', title: '양우산', description: '비도 막고 햇빛도 막고 활용도 높아요', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'travel_goods', title: '보조 가방', description: '짐 늘어나는 순간 바로 필요해요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'travel_goods', title: '여행용 압축 파우치', description: '옷 부피를 줄여 캐리어 공간을 확보해줘요', prepType: 'item', baggageType: 'checked' },
  // 조건부: 열대 바다 국가에서만 추천 (destination 국가명 매칭). 수영용품 6종 분리.
  { categoryCode: 'travel_goods', title: '스노클', description: '물속 구경할 때 있으면 좋아요', prepType: 'item', baggageType: 'checked', conditions: { countries: BEACH_COUNTRIES } },
  { categoryCode: 'travel_goods', title: '수경', description: '수영장·바다에서 눈을 보호해줘요', prepType: 'item', baggageType: 'carry_on', conditions: { countries: BEACH_COUNTRIES } },
  { categoryCode: 'travel_goods', title: '비치타올', description: '해변에서 깔고 닦고 두루 써요', prepType: 'item', baggageType: 'checked', conditions: { countries: BEACH_COUNTRIES } },
  { categoryCode: 'travel_goods', title: '아쿠아삭스', description: '맨발 자극 줄이고 미끄럼을 막아줘요', prepType: 'item', baggageType: 'checked', conditions: { countries: BEACH_COUNTRIES } },
  { categoryCode: 'travel_goods', title: '아쿠아슈즈', description: '바위·산호 바닥에서 발을 보호해요', prepType: 'item', baggageType: 'checked', conditions: { countries: BEACH_COUNTRIES } },
  { categoryCode: 'travel_goods', title: '방수팩', description: '휴대폰·귀중품을 물에서 지켜줘요', prepType: 'item', baggageType: 'carry_on', conditions: { countries: BEACH_COUNTRIES } },
  { categoryCode: 'travel_goods', title: '일회용 베개커버', description: '피부 또는 위생에 민감하면 챙기는 게 좋아요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'travel_goods', title: '비닐봉투/지퍼백', description: '젖은 옷이나 쓰레기 등 따로 담을 때 필요해요', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'travel_goods', title: '샤워기헤드/샤워기필터', description: '수질 안 좋은 나라에서는 필수템이에요', prepType: 'item', baggageType: 'checked' },

  // 사전 예약/신청
  { categoryCode: 'booking', title: '항공권 예약', description: '미리 할수록 싸고 선택지도 많아요', prepType: 'pre_booking', baggageType: 'none', isEssential: true },
  { categoryCode: 'booking', title: '숙소 예약', description: '동선 맞춰서 미리 잡는 게 편해요', prepType: 'pre_booking', baggageType: 'none', isEssential: true },
  { categoryCode: 'booking', title: '여행자 보험', description: '사고나 분실 같은 상황에 대비해요', prepType: 'pre_booking', baggageType: 'none' },
  { categoryCode: 'booking', title: '환전', description: '현금 필요한 상황 꼭 생겨요', prepType: 'pre_booking', baggageType: 'none' },
  { categoryCode: 'booking', title: '이심/유심/로밍/포켓와이파이 신청', description: '유심과 포켓와이파이는 출국에 맞춰 받으려면 사전 신청이 필요해요', prepType: 'pre_booking', baggageType: 'none' },
  { categoryCode: 'booking', title: '여행지 공항 픽업/샌딩 서비스 예약', description: '늦은 시간 도착이면 특히 편해요', prepType: 'pre_booking', baggageType: 'none' },

  // 출국 전 확인사항
  { categoryCode: 'pre_departure', title: '여권 만료일 확인(6개월 이상)', description: '만료일 6개월 미만일 시 출국 자체가 안 돼요', prepType: 'pre_departure_check', baggageType: 'none', isEssential: true },
  { categoryCode: 'pre_departure', title: '온라인 체크인', description: '줄 서는 시간 줄일 수 있어요', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '카운터 오픈/마감 시간 체크', description: '항공사별로 시간이 달라서 확인이 필요해요', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '카운터 위치', description: '미리 확인하고 공항에서 헤매지 마세요', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '캐리어 무게 체크', description: '현장에서 추가 요금 꽤 나와요', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '국가별, 항공사별 수하물 규정 확인', description: '공항에서 문제 생기지 않게 미리 체크해요', prepType: 'pre_departure_check', baggageType: 'none' },
];

async function seedChecklistItemTemplates() {
  const categories = await prisma.checklistCategory.findMany();
  const byCode = new Map(categories.map((c) => [c.code, c]));

  let inserted = 0;
  let updated = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const category = byCode.get(t.categoryCode);
    if (!category) {
      console.warn(`[seed] skip template "${t.title}" (unknown category: ${t.categoryCode})`);
      continue;
    }

    // ChecklistItemTemplate 에는 unique constraint 가 없으므로
    // (categoryId, countryId=null, title) 로 수동 idempotent 처리.
    const existing = await prisma.checklistItemTemplate.findFirst({
      where: { categoryId: category.id, countryId: null, title: t.title },
    });

    const data = {
      categoryId: category.id,
      countryId: null as bigint | null,
      title: t.title,
      description: t.description ?? null,
      prepType: t.prepType,
      baggageType: t.baggageType,
      conditions: (t.conditions ?? {}) as Prisma.InputJsonValue,
      isEssential: t.isEssential ?? false,
    };

    if (existing) {
      await prisma.checklistItemTemplate.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.checklistItemTemplate.create({ data });
      inserted += 1;
    }
  }
  console.log(
    `[seed] checklist_item_templates: ${inserted} inserted, ${updated} updated (total ${DEFAULT_TEMPLATES.length})`,
  );
}

async function seedTravelStyles() {
  const styles = [
    { code: 'foodie', labelKo: '맛집 탐방', iconPath: '/icons/style/foodie.svg' },
    { code: 'landmark', labelKo: '명소 방문', iconPath: '/icons/style/landmark.svg' },
    { code: 'healing', labelKo: '힐링', iconPath: '/icons/style/healing.svg' },
    { code: 'shopping', labelKo: '쇼핑', iconPath: '/icons/style/shopping.svg' },
    { code: 'nature', labelKo: '자연', iconPath: '/icons/style/nature.svg' },
    { code: 'activity', labelKo: '액티비티', iconPath: '/icons/style/activity.svg' },
    { code: 'culture', labelKo: '문화/예술', iconPath: '/icons/style/culture.svg' },
    { code: 'photo', labelKo: '포토스팟', iconPath: '/icons/style/photo.svg' },
    { code: 'nightlife', labelKo: '나이트라이프', iconPath: '/icons/style/nightlife.svg' },
  ];
  for (const s of styles) {
    await prisma.travelStyle.upsert({
      where: { code: s.code },
      update: { labelKo: s.labelKo, iconPath: s.iconPath },
      create: s,
    });
  }
  console.log(`[seed] travel_styles: ${styles.length} rows upserted`);
}

async function seedCompanionTypes() {
  const types = [
    { code: 'alone', labelKo: '혼자' },
    { code: 'couple', labelKo: '연인' },
    { code: 'withKids', labelKo: '아이와 함께' },
    { code: 'friends', labelKo: '친구' },
    { code: 'parents', labelKo: '부모님' },
    { code: 'pets', labelKo: '반려동물' },
  ];
  for (const t of types) {
    await prisma.companionType.upsert({
      where: { code: t.code },
      update: { labelKo: t.labelKo },
      create: t,
    });
  }
  console.log(`[seed] companion_types: ${types.length} rows upserted`);
}

async function main() {
  console.log('[seed] starting...');
  await seedCountries();
  await seedCities();
  await seedChecklistCategories();
  await seedChecklistItemTemplates();
  await seedTravelStyles();
  await seedCompanionTypes();
  console.log('[seed] done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
