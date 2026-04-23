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
    // 기존
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
    // 아시아
    { code: 'CN', nameKo: '중국', nameEn: 'China' },
    { code: 'SG', nameKo: '싱가포르', nameEn: 'Singapore' },
    { code: 'MY', nameKo: '말레이시아', nameEn: 'Malaysia' },
    { code: 'ID', nameKo: '인도네시아', nameEn: 'Indonesia' },
    { code: 'PH', nameKo: '필리핀', nameEn: 'Philippines' },
    { code: 'HK', nameKo: '홍콩', nameEn: 'Hong Kong' },
    { code: 'MO', nameKo: '마카오', nameEn: 'Macao' },
    { code: 'MM', nameKo: '미얀마', nameEn: 'Myanmar' },
    { code: 'IN', nameKo: '인도', nameEn: 'India' },
    { code: 'LK', nameKo: '스리랑카', nameEn: 'Sri Lanka' },
    { code: 'NP', nameKo: '네팔', nameEn: 'Nepal' },
    { code: 'MN', nameKo: '몽골', nameEn: 'Mongolia' },
    // 중동
    { code: 'AE', nameKo: '아랍에미리트', nameEn: 'United Arab Emirates' },
    { code: 'QA', nameKo: '카타르', nameEn: 'Qatar' },
    { code: 'SA', nameKo: '사우디아라비아', nameEn: 'Saudi Arabia' },
    { code: 'IL', nameKo: '이스라엘', nameEn: 'Israel' },
    { code: 'TR', nameKo: '터키', nameEn: 'Turkiye' },
    // 유럽
    { code: 'DE', nameKo: '독일', nameEn: 'Germany' },
    { code: 'CH', nameKo: '스위스', nameEn: 'Switzerland' },
    { code: 'NL', nameKo: '네덜란드', nameEn: 'Netherlands' },
    { code: 'AT', nameKo: '오스트리아', nameEn: 'Austria' },
    { code: 'CZ', nameKo: '체코', nameEn: 'Czech Republic' },
    { code: 'PL', nameKo: '폴란드', nameEn: 'Poland' },
    { code: 'GR', nameKo: '그리스', nameEn: 'Greece' },
    { code: 'PT', nameKo: '포르투갈', nameEn: 'Portugal' },
    { code: 'BE', nameKo: '벨기에', nameEn: 'Belgium' },
    { code: 'SE', nameKo: '스웨덴', nameEn: 'Sweden' },
    { code: 'NO', nameKo: '노르웨이', nameEn: 'Norway' },
    { code: 'DK', nameKo: '덴마크', nameEn: 'Denmark' },
    { code: 'FI', nameKo: '핀란드', nameEn: 'Finland' },
    { code: 'IS', nameKo: '아이슬란드', nameEn: 'Iceland' },
    { code: 'HU', nameKo: '헝가리', nameEn: 'Hungary' },
    { code: 'RO', nameKo: '루마니아', nameEn: 'Romania' },
    { code: 'HR', nameKo: '크로아티아', nameEn: 'Croatia' },
    { code: 'IE', nameKo: '아일랜드', nameEn: 'Ireland' },
    { code: 'RU', nameKo: '러시아', nameEn: 'Russia' },
    // 오세아니아
    { code: 'AU', nameKo: '호주', nameEn: 'Australia' },
    { code: 'NZ', nameKo: '뉴질랜드', nameEn: 'New Zealand' },
    // 아메리카
    { code: 'CA', nameKo: '캐나다', nameEn: 'Canada' },
    { code: 'MX', nameKo: '멕시코', nameEn: 'Mexico' },
    { code: 'BR', nameKo: '브라질', nameEn: 'Brazil' },
    { code: 'AR', nameKo: '아르헨티나', nameEn: 'Argentina' },
    { code: 'CL', nameKo: '칠레', nameEn: 'Chile' },
    // 아프리카
    { code: 'EG', nameKo: '이집트', nameEn: 'Egypt' },
    { code: 'MA', nameKo: '모로코', nameEn: 'Morocco' },
    { code: 'ZA', nameKo: '남아프리카공화국', nameEn: 'South Africa' },
    // 태평양 (미국 자치령)
    { code: 'GU', nameKo: '괌', nameEn: 'Guam' },
    { code: 'MP', nameKo: '사이판', nameEn: 'Saipan (CNMI)' },
    // 동남아 추가
    { code: 'KH', nameKo: '캄보디아', nameEn: 'Cambodia' },
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
    iataCode: string;
    isServed: boolean;
  }> = [
    // 한국
    { countryCode: 'KR', nameKo: '인천', nameEn: 'Incheon', iataCode: 'ICN', isServed: true },
    { countryCode: 'KR', nameKo: '김포', nameEn: 'Gimpo', iataCode: 'GMP', isServed: true },
    { countryCode: 'KR', nameKo: '제주', nameEn: 'Jeju', iataCode: 'CJU', isServed: true },
    { countryCode: 'KR', nameKo: '부산', nameEn: 'Busan', iataCode: 'PUS', isServed: true },
    // 일본
    { countryCode: 'JP', nameKo: '도쿄(나리타)', nameEn: 'Tokyo (Narita)', iataCode: 'NRT', isServed: true },
    { countryCode: 'JP', nameKo: '도쿄(하네다)', nameEn: 'Tokyo (Haneda)', iataCode: 'HND', isServed: true },
    { countryCode: 'JP', nameKo: '오사카', nameEn: 'Osaka', iataCode: 'KIX', isServed: true },
    { countryCode: 'JP', nameKo: '나고야', nameEn: 'Nagoya', iataCode: 'NGO', isServed: true },
    { countryCode: 'JP', nameKo: '후쿠오카', nameEn: 'Fukuoka', iataCode: 'FUK', isServed: true },
    { countryCode: 'JP', nameKo: '나가사키', nameEn: 'Nagasaki', iataCode: 'NGS', isServed: true },
    { countryCode: 'JP', nameKo: '히로시마', nameEn: 'Hiroshima', iataCode: 'HIJ', isServed: true },
    { countryCode: 'JP', nameKo: '구마모토', nameEn: 'Kumamoto', iataCode: 'KMJ', isServed: true },
    { countryCode: 'JP', nameKo: '삿포로', nameEn: 'Sapporo', iataCode: 'CTS', isServed: true },
    { countryCode: 'JP', nameKo: '오키나와', nameEn: 'Okinawa', iataCode: 'OKA', isServed: true },
    // 중국
    { countryCode: 'CN', nameKo: '베이징', nameEn: 'Beijing', iataCode: 'PEK', isServed: true },
    { countryCode: 'CN', nameKo: '상하이', nameEn: 'Shanghai', iataCode: 'PVG', isServed: true },
    { countryCode: 'CN', nameKo: '청두', nameEn: 'Chengdu', iataCode: 'CTU', isServed: true },
    { countryCode: 'CN', nameKo: '하이난(싼야)', nameEn: 'Sanya (Hainan)', iataCode: 'SYX', isServed: true },
    { countryCode: 'CN', nameKo: '하이난(하이커우)', nameEn: 'Haikou (Hainan)', iataCode: 'HAK', isServed: true },
    { countryCode: 'CN', nameKo: '장가계', nameEn: 'Zhangjiajie', iataCode: 'DYG', isServed: true },
    { countryCode: 'CN', nameKo: '계림', nameEn: 'Guilin', iataCode: 'KWL', isServed: true },
    { countryCode: 'CN', nameKo: '광저우', nameEn: 'Guangzhou', iataCode: 'CAN', isServed: true },
    { countryCode: 'CN', nameKo: '선전', nameEn: 'Shenzhen', iataCode: 'SZX', isServed: true },
    // 대만
    { countryCode: 'TW', nameKo: '타이베이(타오위안)', nameEn: 'Taipei (Taoyuan)', iataCode: 'TPE', isServed: true },
    { countryCode: 'TW', nameKo: '타이베이(쑹산)', nameEn: 'Taipei (Songshan)', iataCode: 'TSA', isServed: true },
    { countryCode: 'TW', nameKo: '타이중', nameEn: 'Taichung', iataCode: 'RMQ', isServed: true },
    { countryCode: 'TW', nameKo: '가오슝', nameEn: 'Kaohsiung', iataCode: 'KHH', isServed: true },
    // 베트남
    { countryCode: 'VN', nameKo: '호치민', nameEn: 'Ho Chi Minh City', iataCode: 'SGN', isServed: true },
    { countryCode: 'VN', nameKo: '하노이', nameEn: 'Hanoi', iataCode: 'HAN', isServed: true },
    { countryCode: 'VN', nameKo: '다낭', nameEn: 'Da Nang', iataCode: 'DAD', isServed: true },
    { countryCode: 'VN', nameKo: '나트랑', nameEn: 'Nha Trang', iataCode: 'CXR', isServed: true },
    { countryCode: 'VN', nameKo: '푸꾸옥', nameEn: 'Phu Quoc', iataCode: 'PQC', isServed: true },
    // 태국
    { countryCode: 'TH', nameKo: '방콕(수완나품)', nameEn: 'Bangkok (Suvarnabhumi)', iataCode: 'BKK', isServed: true },
    { countryCode: 'TH', nameKo: '방콕(돈므앙)', nameEn: 'Bangkok (Don Mueang)', iataCode: 'DMK', isServed: true },
    { countryCode: 'TH', nameKo: '치앙마이', nameEn: 'Chiang Mai', iataCode: 'CNX', isServed: true },
    { countryCode: 'TH', nameKo: '푸켓', nameEn: 'Phuket', iataCode: 'HKT', isServed: true },
    { countryCode: 'TH', nameKo: '파타야', nameEn: 'Pattaya', iataCode: 'UTP', isServed: true },
    { countryCode: 'TH', nameKo: '코사무이', nameEn: 'Ko Samui', iataCode: 'USM', isServed: true },
    // 싱가포르
    { countryCode: 'SG', nameKo: '싱가포르', nameEn: 'Singapore', iataCode: 'SIN', isServed: true },
    // 말레이시아
    { countryCode: 'MY', nameKo: '쿠알라룸푸르', nameEn: 'Kuala Lumpur', iataCode: 'KUL', isServed: true },
    { countryCode: 'MY', nameKo: '코타키나발루', nameEn: 'Kota Kinabalu', iataCode: 'BKI', isServed: true },
    { countryCode: 'MY', nameKo: '페낭', nameEn: 'Penang', iataCode: 'PEN', isServed: true },
    // 인도네시아
    { countryCode: 'ID', nameKo: '발리(응우라라이)', nameEn: 'Bali (Ngurah Rai)', iataCode: 'DPS', isServed: true },
    { countryCode: 'ID', nameKo: '자카르타', nameEn: 'Jakarta', iataCode: 'CGK', isServed: true },
    // 필리핀
    { countryCode: 'PH', nameKo: '마닐라', nameEn: 'Manila', iataCode: 'MNL', isServed: true },
    { countryCode: 'PH', nameKo: '세부', nameEn: 'Cebu', iataCode: 'CEB', isServed: true },
    { countryCode: 'PH', nameKo: '보라카이(칼리보)', nameEn: 'Boracay (Kalibo)', iataCode: 'KLO', isServed: true },
    { countryCode: 'PH', nameKo: '팔라완', nameEn: 'Palawan', iataCode: 'PPS', isServed: true },
    // 괌 / 사이판
    { countryCode: 'GU', nameKo: '괌', nameEn: 'Guam', iataCode: 'GUM', isServed: true },
    { countryCode: 'MP', nameKo: '사이판', nameEn: 'Saipan', iataCode: 'GSN', isServed: true },
    // 캄보디아
    { countryCode: 'KH', nameKo: '시엠립', nameEn: 'Siem Reap', iataCode: 'REP', isServed: true },
    { countryCode: 'KH', nameKo: '프놈펜', nameEn: 'Phnom Penh', iataCode: 'PNH', isServed: true },
    // 홍콩
    { countryCode: 'HK', nameKo: '홍콩', nameEn: 'Hong Kong', iataCode: 'HKG', isServed: true },
    // 마카오
    { countryCode: 'MO', nameKo: '마카오', nameEn: 'Macao', iataCode: 'MFM', isServed: true },
    // 미얀마
    { countryCode: 'MM', nameKo: '양곤', nameEn: 'Yangon', iataCode: 'RGN', isServed: true },
    // 인도
    { countryCode: 'IN', nameKo: '델리', nameEn: 'Delhi', iataCode: 'DEL', isServed: true },
    // 스리랑카
    { countryCode: 'LK', nameKo: '콜롬보', nameEn: 'Colombo', iataCode: 'CMB', isServed: true },
    // 네팔
    { countryCode: 'NP', nameKo: '카트만두', nameEn: 'Kathmandu', iataCode: 'KTM', isServed: true },
    // 몽골
    { countryCode: 'MN', nameKo: '울란바토르', nameEn: 'Ulaanbaatar', iataCode: 'UBN', isServed: true },
    // 중동
    { countryCode: 'AE', nameKo: '두바이', nameEn: 'Dubai', iataCode: 'DXB', isServed: true },
    { countryCode: 'QA', nameKo: '도하', nameEn: 'Doha', iataCode: 'DOH', isServed: true },
    { countryCode: 'SA', nameKo: '리야드', nameEn: 'Riyadh', iataCode: 'RUH', isServed: true },
    { countryCode: 'IL', nameKo: '텔아비브', nameEn: 'Tel Aviv', iataCode: 'TLV', isServed: true },
    { countryCode: 'TR', nameKo: '이스탄불', nameEn: 'Istanbul', iataCode: 'IST', isServed: true },
    // 미국
    { countryCode: 'US', nameKo: '로스앤젤레스', nameEn: 'Los Angeles', iataCode: 'LAX', isServed: true },
    { countryCode: 'US', nameKo: '뉴욕(JFK)', nameEn: 'New York (JFK)', iataCode: 'JFK', isServed: true },
    { countryCode: 'US', nameKo: '뉴욕(뉴왁)', nameEn: 'New York (Newark)', iataCode: 'EWR', isServed: true },
    { countryCode: 'US', nameKo: '샌프란시스코', nameEn: 'San Francisco', iataCode: 'SFO', isServed: true },
    { countryCode: 'US', nameKo: '시카고', nameEn: 'Chicago', iataCode: 'ORD', isServed: true },
    { countryCode: 'US', nameKo: '시애틀', nameEn: 'Seattle', iataCode: 'SEA', isServed: true },
    { countryCode: 'US', nameKo: '라스베이거스', nameEn: 'Las Vegas', iataCode: 'LAS', isServed: true },
    { countryCode: 'US', nameKo: '호놀룰루', nameEn: 'Honolulu', iataCode: 'HNL', isServed: true },
    // 캐나다
    { countryCode: 'CA', nameKo: '밴쿠버', nameEn: 'Vancouver', iataCode: 'YVR', isServed: true },
    { countryCode: 'CA', nameKo: '토론토', nameEn: 'Toronto', iataCode: 'YYZ', isServed: true },
    { countryCode: 'CA', nameKo: '몬트리올', nameEn: 'Montreal', iataCode: 'YUL', isServed: true },
    // 중남미
    { countryCode: 'MX', nameKo: '멕시코시티', nameEn: 'Mexico City', iataCode: 'MEX', isServed: true },
    { countryCode: 'BR', nameKo: '상파울루', nameEn: 'Sao Paulo', iataCode: 'GRU', isServed: true },
    { countryCode: 'AR', nameKo: '부에노스아이레스', nameEn: 'Buenos Aires', iataCode: 'EZE', isServed: true },
    { countryCode: 'CL', nameKo: '산티아고', nameEn: 'Santiago', iataCode: 'SCL', isServed: true },
    // 아프리카
    { countryCode: 'EG', nameKo: '카이로', nameEn: 'Cairo', iataCode: 'CAI', isServed: true },
    { countryCode: 'MA', nameKo: '카사블랑카', nameEn: 'Casablanca', iataCode: 'CMN', isServed: true },
    { countryCode: 'ZA', nameKo: '요하네스버그', nameEn: 'Johannesburg', iataCode: 'JNB', isServed: true },
    // 프랑스
    { countryCode: 'FR', nameKo: '파리(CDG)', nameEn: 'Paris (CDG)', iataCode: 'CDG', isServed: true },
    { countryCode: 'FR', nameKo: '파리(오를리)', nameEn: 'Paris (Orly)', iataCode: 'ORY', isServed: true },
    { countryCode: 'FR', nameKo: '니스', nameEn: 'Nice', iataCode: 'NCE', isServed: true },
    // 이탈리아
    { countryCode: 'IT', nameKo: '로마', nameEn: 'Rome', iataCode: 'FCO', isServed: true },
    { countryCode: 'IT', nameKo: '밀라노', nameEn: 'Milan', iataCode: 'MXP', isServed: true },
    { countryCode: 'IT', nameKo: '베네치아', nameEn: 'Venice', iataCode: 'VCE', isServed: true },
    // 스페인
    { countryCode: 'ES', nameKo: '마드리드', nameEn: 'Madrid', iataCode: 'MAD', isServed: true },
    { countryCode: 'ES', nameKo: '바르셀로나', nameEn: 'Barcelona', iataCode: 'BCN', isServed: true },
    // 독일
    { countryCode: 'DE', nameKo: '프랑크푸르트', nameEn: 'Frankfurt', iataCode: 'FRA', isServed: true },
    { countryCode: 'DE', nameKo: '뮌헨', nameEn: 'Munich', iataCode: 'MUC', isServed: true },
    { countryCode: 'DE', nameKo: '베를린', nameEn: 'Berlin', iataCode: 'BER', isServed: true },
    // 영국
    { countryCode: 'GB', nameKo: '런던(히스로)', nameEn: 'London (Heathrow)', iataCode: 'LHR', isServed: true },
    { countryCode: 'GB', nameKo: '런던(개트윅)', nameEn: 'London (Gatwick)', iataCode: 'LGW', isServed: true },
    { countryCode: 'GB', nameKo: '맨체스터', nameEn: 'Manchester', iataCode: 'MAN', isServed: true },
    { countryCode: 'GB', nameKo: '에든버러', nameEn: 'Edinburgh', iataCode: 'EDI', isServed: true },
    // 기타 유럽
    { countryCode: 'CH', nameKo: '취리히', nameEn: 'Zurich', iataCode: 'ZRH', isServed: true },
    { countryCode: 'NL', nameKo: '암스테르담', nameEn: 'Amsterdam', iataCode: 'AMS', isServed: true },
    { countryCode: 'AT', nameKo: '비엔나', nameEn: 'Vienna', iataCode: 'VIE', isServed: true },
    { countryCode: 'CZ', nameKo: '프라하', nameEn: 'Prague', iataCode: 'PRG', isServed: true },
    { countryCode: 'PL', nameKo: '바르샤바', nameEn: 'Warsaw', iataCode: 'WAW', isServed: true },
    { countryCode: 'GR', nameKo: '아테네', nameEn: 'Athens', iataCode: 'ATH', isServed: true },
    { countryCode: 'PT', nameKo: '리스본', nameEn: 'Lisbon', iataCode: 'LIS', isServed: true },
    { countryCode: 'BE', nameKo: '브뤼셀', nameEn: 'Brussels', iataCode: 'BRU', isServed: true },
    { countryCode: 'SE', nameKo: '스톡홀름', nameEn: 'Stockholm', iataCode: 'ARN', isServed: true },
    { countryCode: 'NO', nameKo: '오슬로', nameEn: 'Oslo', iataCode: 'OSL', isServed: true },
    { countryCode: 'DK', nameKo: '코펜하겐', nameEn: 'Copenhagen', iataCode: 'CPH', isServed: true },
    { countryCode: 'FI', nameKo: '헬싱키', nameEn: 'Helsinki', iataCode: 'HEL', isServed: true },
    { countryCode: 'IS', nameKo: '레이캬비크', nameEn: 'Reykjavik', iataCode: 'KEF', isServed: true },
    { countryCode: 'HU', nameKo: '부다페스트', nameEn: 'Budapest', iataCode: 'BUD', isServed: true },
    { countryCode: 'RO', nameKo: '부쿠레슈티', nameEn: 'Bucharest', iataCode: 'OTP', isServed: true },
    { countryCode: 'HR', nameKo: '자그레브', nameEn: 'Zagreb', iataCode: 'ZAG', isServed: true },
    { countryCode: 'IE', nameKo: '더블린', nameEn: 'Dublin', iataCode: 'DUB', isServed: true },
    { countryCode: 'RU', nameKo: '모스크바', nameEn: 'Moscow', iataCode: 'SVO', isServed: true },
    // 오세아니아
    { countryCode: 'AU', nameKo: '시드니', nameEn: 'Sydney', iataCode: 'SYD', isServed: true },
    { countryCode: 'AU', nameKo: '멜버른', nameEn: 'Melbourne', iataCode: 'MEL', isServed: true },
    { countryCode: 'AU', nameKo: '브리즈번', nameEn: 'Brisbane', iataCode: 'BNE', isServed: true },
    { countryCode: 'NZ', nameKo: '오클랜드', nameEn: 'Auckland', iataCode: 'AKL', isServed: true },
  ];

  for (const p of pairs) {
    const country = await prisma.country.findUnique({ where: { code: p.countryCode } });
    if (!country) {
      console.warn(`[seed] skip city ${p.iataCode}: country ${p.countryCode} not found`);
      continue;
    }

    // iataCode 기준으로 조회 — nameEn 기준보다 정확하고 idempotent하다.
    const existing = await prisma.city.findFirst({ where: { iataCode: p.iataCode } });
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
