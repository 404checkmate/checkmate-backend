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
    { code: 'KR', nameKo: '대한민국', nameEn: 'South Korea' },
    { code: 'JP', nameKo: '일본', nameEn: 'Japan' },
    { code: 'TW', nameKo: '대만', nameEn: 'Taiwan' },
    { code: 'VN', nameKo: '베트남', nameEn: 'Vietnam' },
    { code: 'TH', nameKo: '태국', nameEn: 'Thailand' },
    { code: 'US', nameKo: '미국', nameEn: 'United States' },
    { code: 'FR', nameKo: '프랑스', nameEn: 'France' },
    { code: 'IT', nameKo: '이탈리아', nameEn: 'Italy' },
    { code: 'ES', nameKo: '스페인', nameEn: 'Spain' },
    { code: 'GB', nameKo: '영국', nameEn: 'United Kingdom' },
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
    iataCode?: string;
    isServed: boolean;
  }> = [
    { countryCode: 'JP', nameKo: '도쿄', nameEn: 'Tokyo', iataCode: 'NRT', isServed: true },
    { countryCode: 'JP', nameKo: '오사카', nameEn: 'Osaka', iataCode: 'KIX', isServed: true },
    { countryCode: 'JP', nameKo: '후쿠오카', nameEn: 'Fukuoka', iataCode: 'FUK', isServed: true },
    { countryCode: 'TW', nameKo: '타이베이', nameEn: 'Taipei', iataCode: 'TPE', isServed: true },
    { countryCode: 'VN', nameKo: '하노이', nameEn: 'Hanoi', iataCode: 'HAN', isServed: true },
    { countryCode: 'VN', nameKo: '다낭', nameEn: 'Da Nang', iataCode: 'DAD', isServed: true },
    { countryCode: 'TH', nameKo: '방콕', nameEn: 'Bangkok', iataCode: 'BKK', isServed: true },
    { countryCode: 'US', nameKo: '로스앤젤레스', nameEn: 'Los Angeles', iataCode: 'LAX', isServed: true },
    { countryCode: 'FR', nameKo: '파리', nameEn: 'Paris', iataCode: 'CDG', isServed: true },
    { countryCode: 'IT', nameKo: '로마', nameEn: 'Rome', iataCode: 'FCO', isServed: true },
  ];

  for (const p of pairs) {
    const country = await prisma.country.findUnique({ where: { code: p.countryCode } });
    if (!country) continue;

    const existing = await prisma.city.findFirst({
      where: { countryId: country.id, nameEn: p.nameEn },
    });
    if (existing) {
      await prisma.city.update({
        where: { id: existing.id },
        data: {
          nameKo: p.nameKo,
          iataCode: p.iataCode ?? null,
          isServed: p.isServed,
        },
      });
    } else {
      await prisma.city.create({
        data: {
          countryId: country.id,
          nameKo: p.nameKo,
          nameEn: p.nameEn,
          iataCode: p.iataCode ?? null,
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
};

const DEFAULT_TEMPLATES: TemplateSeed[] = [
  // 필수 준비물
  { categoryCode: 'essentials', title: '항공권(e티켓 캡처, 출력본)', prepType: 'item', baggageType: 'none', isEssential: true },
  { categoryCode: 'essentials', title: '여권, 여권 복사본', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '이심 / 유심 / 로밍 / 포켓 와이파이', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '해외 결제 카드', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '약간의 현금', prepType: 'item', baggageType: 'carry_on', isEssential: true },
  { categoryCode: 'essentials', title: '볼펜', prepType: 'item', baggageType: 'carry_on' },

  // 입을 옷
  { categoryCode: 'clothing', title: '여벌옷', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '잠옷', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '속옷', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '양말', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'clothing', title: '편한 신발', prepType: 'item', baggageType: 'none' },
  { categoryCode: 'clothing', title: '모자', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'clothing', title: '선글라스', prepType: 'item', baggageType: 'carry_on' },

  // 상비약
  { categoryCode: 'health', title: '감기약', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '해열진통제', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '지사제', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '소화제', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '연고/소독약', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '알콜스왑', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'health', title: '밴드', prepType: 'item', baggageType: 'carry_on' },

  // 세면도구
  { categoryCode: 'toiletries', title: '칫솔, 치약', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '세안용품(클렌징폼, 클렌징오일, 립앤아이 리무버)', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '샤워용품(샴푸, 린스, 바디워시)', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '면봉/화장솜', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'toiletries', title: '면도기/제모기', prepType: 'item', baggageType: 'checked' },

  // 미용용품
  { categoryCode: 'beauty', title: '스킨케어 (스킨, 로션, 립밤, 핸드크림)', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '자외선 차단제 (크림, 스틱, 스프레이)', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '색조 화장품', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '헤어용품(머리끈, 머리핀, 헤어롤)', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'beauty', title: '헤어제품 (에센스/오일/왁스/스프레이)', prepType: 'item', baggageType: 'checked' },

  // 전자제품
  { categoryCode: 'electronics', title: '보조배터리', description: '항공사 규정상 반드시 기내 반입', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'electronics', title: '충전기 (용도에 따라)', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'electronics', title: '해외 멀티 어댑터', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'electronics', title: '이어폰', prepType: 'item', baggageType: 'carry_on' },

  // 여행용품
  { categoryCode: 'travel_goods', title: '휴대용 휴지, 물티슈', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'travel_goods', title: '양우산', prepType: 'item', baggageType: 'carry_on' },
  { categoryCode: 'travel_goods', title: '보조 가방', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'travel_goods', title: '일회용 베개커버', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'travel_goods', title: '비닐봉투/지퍼백', prepType: 'item', baggageType: 'checked' },
  { categoryCode: 'travel_goods', title: '샤워기헤드/샤워기필터', prepType: 'item', baggageType: 'checked' },

  // 사전 예약/신청
  { categoryCode: 'booking', title: '항공권 예약', prepType: 'pre_booking', baggageType: 'none', isEssential: true },
  { categoryCode: 'booking', title: '숙소 예약', prepType: 'pre_booking', baggageType: 'none', isEssential: true },
  { categoryCode: 'booking', title: '여행자 보험', prepType: 'pre_booking', baggageType: 'none' },
  { categoryCode: 'booking', title: '환전', prepType: 'pre_booking', baggageType: 'none' },
  { categoryCode: 'booking', title: '이심/유심/로밍/포켓와이파이 신청', prepType: 'pre_booking', baggageType: 'none' },
  { categoryCode: 'booking', title: '여행지 공항 픽업/샌딩 서비스 예약', prepType: 'pre_booking', baggageType: 'none' },

  // 출국 전 확인사항
  { categoryCode: 'pre_departure', title: '여권 만료일 확인(6개월 이상)', prepType: 'pre_departure_check', baggageType: 'none', isEssential: true },
  { categoryCode: 'pre_departure', title: '온라인 체크인', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '카운터 오픈/마감 시간 체크', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '카운터 위치', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '캐리어 무게 체크', prepType: 'pre_departure_check', baggageType: 'none' },
  { categoryCode: 'pre_departure', title: '국가별, 항공사별 수하물 규정 확인', prepType: 'pre_departure_check', baggageType: 'none' },
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
      conditions: {} as Prisma.InputJsonValue,
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
