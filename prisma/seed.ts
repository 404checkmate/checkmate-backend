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
 * - travel_styles
 * - companion_types
 *
 * 모든 upsert는 idempotent — 여러 번 실행해도 안전합니다.
 */
import { PrismaClient } from '@prisma/client';

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
  const categories = [
    { code: 'documents', labelKo: '서류', sortOrder: 1 },
    { code: 'electronics', labelKo: '전자기기', sortOrder: 2 },
    { code: 'clothing', labelKo: '의류', sortOrder: 3 },
    { code: 'packing', labelKo: '짐 꾸리기', sortOrder: 4 },
    { code: 'health', labelKo: '건강/약', sortOrder: 5 },
    { code: 'activity', labelKo: '액티비티', sortOrder: 6 },
    { code: 'booking', labelKo: '예약', sortOrder: 7 },
    { code: 'ai_recommend', labelKo: 'AI 추천', sortOrder: 8 },
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

async function seedTravelStyles() {
  const styles = [
    { code: 'foodie', labelKo: '맛집 탐방', iconPath: '/icons/style/foodie.svg' },
    { code: 'landmark', labelKo: '명소 방문', iconPath: '/icons/style/landmark.svg' },
    { code: 'healing', labelKo: '힐링', iconPath: '/icons/style/healing.svg' },
    { code: 'shopping', labelKo: '쇼핑', iconPath: '/icons/style/shopping.svg' },
    { code: 'nature', labelKo: '자연', iconPath: '/icons/style/nature.svg' },
    { code: 'activity', labelKo: '액티비티', iconPath: '/icons/style/activity.svg' },
    { code: 'culture', labelKo: '문화/예술', iconPath: '/icons/style/culture.svg' },
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
