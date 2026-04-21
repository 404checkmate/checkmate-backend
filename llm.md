# Checkmate - 맞춤형 체크리스트 생성 기능 구현 기록

> 요청: 여행 체크리스트 앱 "Checkmate"에 사용자 맞춤형 체크리스트를 자동 생성해주는 기능 구현
> 구성: **기본 준비물 DB 시드** + **OpenAI(gpt-4o-mini) 연동** + **통합 API(중복 제거 Merge)**
> 스택: NestJS 11 · Prisma 6 · PostgreSQL(Supabase) · OpenAI SDK

---

## 1. 환경 감지 결과

작업 시작 전 자동 탐지한 프로젝트 환경.

| 항목 | 값 |
| --- | --- |
| 프레임워크 | NestJS 11 (TypeScript) |
| ORM | Prisma 6 (`@prisma/client`) |
| DB | PostgreSQL (Supabase) |
| 시드 파일 | `prisma/seed.ts` (npm-script: `prisma:seed`) |
| 체크리스트 도메인 | `src/modules/checklists/` 이미 존재 |
| LLM 도메인 | `src/modules/llm/` 이미 존재 (큐잉 스텁만 있던 상태) |
| 템플릿 모델 | `ChecklistItemTemplate` (category, country, prepType, baggageType, conditions, isEssential) |
| 기존 enum | `PrepType { item, pre_booking, pre_departure_check, ai_recommend }`, `BaggageType { carry_on, checked, none }` |
| 환경변수 | `.env` 에 `LLM_API_KEY` / `LLM_MODEL=gpt-4o-mini` 이미 정의 |
| Config 경로 | `llm.apiKey`, `llm.model` (via `ConfigService`) |

**결정 사항**: 기존 Prisma 모델(`ChecklistItemTemplate`)과 enum(`PrepType`/`BaggageType`/`ChecklistCategory`) 을 **그대로 재사용**. 새 테이블이나 마이그레이션은 생성하지 않음. 필요한 값은 시드로만 주입.

---

## 2. 변경/추가된 파일 목록

| 구분 | 경로 | 내용 |
| --- | --- | --- |
| ✏️ 수정 | `prisma/seed.ts` | 9개 기본 카테고리 추가 + 기본 준비물 48개 템플릿 시드 |
| ➕ 신규 | `src/modules/llm/openai.service.ts` | OpenAI `gpt-4o-mini` 연동. 추가 물품 JSON 추천 |
| ✏️ 수정 | `src/modules/llm/llm.module.ts` | `OpenaiService` provider/export 등록 |
| ✏️ 수정 | `src/modules/checklists/checklists.service.ts` | `generateForTrip()` 통합 메서드 (Merge + 중복 제거) |
| ✏️ 수정 | `src/modules/checklists/checklists.controller.ts` | `POST /checklists/generate/:tripId` 엔드포인트 |
| ✏️ 수정 | `src/modules/checklists/checklists.module.ts` | `LlmModule` import |
| ✏️ 수정 | `package.json` | `openai@^4.104.0` 의존성 추가 |

**빌드/린트 결과**: `npx nest build` 성공, `npx tsc --noEmit prisma/seed.ts` 성공, ESLint 에러 0건.

---

## 3. 기본 준비물 DB 저장 (Seed)

### 3-1. 카테고리 개편

요청 사항의 9개 섹션이 기존 enum-like 카테고리와 정확히 매핑되지 않았기 때문에, **기존 카테고리는 유지하면서 새 9개를 추가**했다. `sortOrder` 를 1~9 로 새 카테고리에 부여하고 기존 카테고리는 90~99 로 뒤로 밀어 UI 순서를 자연스럽게 유지.

| 요청 섹션 | 매핑 code | sortOrder |
| --- | --- | --- |
| 필수 준비물 | `essentials` | 1 |
| 입을 옷 | `clothing` | 2 |
| 상비약 | `health` | 3 |
| 세면도구 | `toiletries` | 4 |
| 미용용품 | `beauty` | 5 |
| 전자제품 | `electronics` | 6 |
| 여행용품 | `travel_goods` | 7 |
| 사전 예약/신청 | `booking` | 8 |
| 출국 전 확인사항 | `pre_departure` | 9 |
| (기존) 서류 | `documents` | 90 |
| (기존) 짐 꾸리기 | `packing` | 91 |
| (기존) 액티비티 | `activity` | 92 |
| (기존) AI 추천 | `ai_recommend` | 99 |

### 3-2. 기본 준비물 템플릿 시드

`ChecklistItemTemplate` 은 `(categoryCode, countryCode, title)` 에 대한 unique 제약이 없기 때문에, 시드는 **수동 idempotent 패턴**(먼저 `findFirst` → 존재하면 `update`, 없으면 `create`)으로 작성. `countryId = null` 로 저장 → 전 세계 공통 기본 항목.

요청하신 전 항목(총 48건)을 섹션별로 삽입:

| 섹션 | 항목 수 | 주요 baggageType | 주요 prepType |
| --- | ---:| --- | --- |
| 필수 준비물 | 6 | `carry_on` (항공권만 `none`) | `item` |
| 입을 옷 | 7 | `checked` + 착용품 `none` | `item` |
| 상비약 | 7 | `carry_on` | `item` |
| 세면도구 | 5 | `checked` | `item` |
| 미용용품 | 5 | `checked` | `item` |
| 전자제품 | 4 | `carry_on` (보조배터리 주석 포함) | `item` |
| 여행용품 | 6 | `carry_on` / `checked` 혼합 | `item` |
| 사전 예약/신청 | 6 | `none` | `pre_booking` |
| 출국 전 확인사항 | 6 | `none` | `pre_departure_check` |

`isEssential=true` 로 마크한 항목: 항공권, 여권/여권사본, eSIM/유심, 해외 카드, 약간의 현금, 항공권 예약, 숙소 예약, 여권 만료일 확인.

### 3-3. 실행

```bash
npm run prisma:seed
```

- `seedChecklistCategories()` 13건 upsert (code 기준)
- `seedChecklistItemTemplates()` 48건 insert/update (중복 실행 안전)

---

## 4. OpenAI API 연동 모듈

### 4-1. 패키지 설치

```bash
npm install openai@^4.77.0 --save
# → openai@4.104.0 설치됨
```

### 4-2. `src/modules/llm/openai.service.ts`

- **모델**: `gpt-4o-mini` (env: `LLM_MODEL` 에서 오버라이드 가능)
- **클라이언트 lazy-init**: `LLM_API_KEY` 가 비어있으면 생성 시점에서만 에러 던짐(부팅 시 죽지 않음)
- **입력 타입 `TripContext`**
  ```ts
  {
    destination: string;       // "태국 (방콕, 치앙마이)"
    durationDays: number;      // 5
    season: string;            // "여름"
    companions: string[];      // ["친구", "반려동물"]
    purposes: string[];        // ["맛집 탐방", "쇼핑"]
  }
  ```
- **출력 타입 `AdditionalItem`**
  ```ts
  {
    title: string;
    category: 'essentials' | 'clothing' | ... | 'ai_recommend';
    description?: string;
    prep_type: 'item' | 'pre_booking' | 'pre_departure_check';
    baggage_type: 'carry_on' | 'checked' | 'none';
  }
  ```
- **JSON 강제**: `response_format: { type: 'json_object' }` + 프롬프트 재강조
- **Temperature**: 0.4 (일관성 ↑, 창의성 약간)
- **프롬프트 핵심 지시사항** (system role)
  1. "기본 용품(여권, 기본 옷, 세면도구, 상비약, 충전기, 보조배터리, 선글라스, 모자, 사전 예약 기본 항목, 출국 전 기본 확인사항 등)은 이미 서비스 기본 체크리스트로 제공됨 — **절대 중복 추천 금지**"
  2. "사용자의 특정 상황(목적지 기후/문화, 계절, 동반자, 여행 목적)에 **특별히 필요한 추가 물품만**" 추천
  3. 예시 제공: 방콕 우기 → 모기 기피제/방수 파우치, 홋카이도 겨울+아이 → 핫팩/아이젠, 발리 서핑 → 래시가드/아쿠아슈즈
  4. 카테고리 화이트리스트 나열 (허용 값 외엔 사용 금지)
  5. 최대 10개까지
- **응답 후처리 (방어 코드)**
  - JSON 파싱 실패 → `{ items: [] }` 로 fallback (로그 경고)
  - title 누락/공백인 항목 필터
  - `category` 가 화이트리스트에 없으면 → `ai_recommend` 로 강등
  - `prep_type` / `baggage_type` 가 enum 범위 밖이면 → `item` / `carry_on` 으로 기본값 처리
- **반환값**: `{ items, usage: { tokens, model } }` — 호출부에서 사용량 로깅 가능

### 4-3. 모듈 등록 — `llm.module.ts`

```ts
providers: [LlmService, OpenaiService],
exports:   [LlmService, OpenaiService],
```

`OpenaiService` 를 export 해 `ChecklistsModule` 에서 주입 받을 수 있도록 함.

---

## 5. 체크리스트 통합 API

### 5-1. 엔드포인트

```
POST /api/checklists/generate/:tripId
HTTP 200
```

> 주의: 현재 구현은 **"미리보기" 응답만 반환**하고 `ChecklistItem` 테이블에 INSERT 하지 않음.
> 프론트에서 확인/편집 후 저장용 엔드포인트를 별도 호출하는 2단계 설계를 의도함.
> 필요 시 `generateForTrip()` 결과를 `prisma.checklistItem.createMany` 로 영속화하는 엔드포인트를 덧붙이면 됨.

### 5-2. 동작 흐름 (`ChecklistsService.generateForTrip`)

```
1. Trip 조회 (country, cities, companions, travelStyles include)
     └─ 없으면 404 NotFoundException
2. buildTripContext(trip) → TripContext 조립
     ├─ destination: "국가명 (도시1, 도시2)"
     ├─ durationDays: tripEnd - tripStart + 1 (최소 1일)
     ├─ season: tripStart 월 기반 북반구 휴리스틱 (3~5:봄 / 6~8:여름 / 9~11:가을 / else:겨울)
     ├─ companions: companionType.labelKo 배열 + hasPet → "반려동물" 추가
     └─ purposes: travelStyle.labelKo 배열 (예: "맛집 탐방", "쇼핑")
3. DB 기본 템플릿 로드 (countryId=null, category.sortOrder 순)
4. OpenaiService.recommendAdditionalItems(context) 호출
     └─ 실패 시 catch → llmItems=[] (기본 템플릿만 반환하는 graceful fallback)
5. 중복 제거 Merge
     ├─ normalizeTitle(): trim + lowercase + 공백/구두점 제거
     ├─ template 항목 먼저 Set 에 등록
     └─ LLM 항목은 같은 key 있으면 drop, duplicatesRemoved 카운트
6. 카테고리별 그룹핑 (category.sortOrder 순)
     └─ 빈 섹션 제외
7. 응답 반환
```

### 5-3. 응답 스키마

```jsonc
{
  "tripId": "12",
  "context": {
    "destination": "태국 (방콕)",
    "durationDays": 5,
    "season": "여름",
    "companions": ["친구"],
    "purposes": ["맛집 탐방", "쇼핑"]
  },
  "summary": {
    "total": 56,              // 중복 제거 후 전체 아이템 수
    "fromTemplate": 48,       // DB 템플릿 기여
    "fromLlm": 10,            // OpenAI 기여
    "duplicatesRemoved": 2,   // 중복으로 버려진 LLM 항목 수
    "llmTokensUsed": 612,
    "model": "gpt-4o-mini"
  },
  "sections": [
    {
      "categoryCode": "essentials",
      "categoryLabel": "필수 준비물",
      "items": [ { "title": "...", "source": "template", ... } ]
    },
    { "categoryCode": "clothing", "categoryLabel": "입을 옷", "items": [ ... ] }
    // ... (빈 섹션은 생략)
  ],
  "items": [ /* flatten — 섹션을 무시하고 평면 리스트로 쓰고 싶을 때용 */ ]
}
```

각 item 필드:

| 필드 | 타입 | 비고 |
| --- | --- | --- |
| `title` | string | |
| `description` | string? | |
| `categoryCode` | string | essentials, clothing, ... |
| `categoryLabel` | string | 한국어 라벨 |
| `prepType` | `item` / `pre_booking` / `pre_departure_check` / `ai_recommend` | |
| `baggageType` | `carry_on` / `checked` / `none` | |
| `source` | `'template'` \| `'llm'` | 출처 구분 |
| `isEssential` | boolean | |
| `orderIndex` | number | 섹션 내 순서 힌트 |

### 5-4. 중복 제거 규칙

```ts
normalizeTitle(title) =
  title.trim().toLowerCase()
       .replace(/\s+/g, '')
       .replace(/[.,/·\-()[\]{}]/g, '')
```

- "보조 배터리" / "보조배터리" / "보조-배터리" 를 같은 항목으로 취급
- `template` 우선 → LLM 쪽이 같은 key 를 돌려주면 조용히 버림 + `duplicatesRemoved++`
- 이로써 LLM 이 프롬프트 지시를 어기고 중복 항목을 내놓더라도 서버 레이어에서 차단

---

## 6. 사용법 (end-to-end)

```bash
cd checkmate-backend

# 1) .env 에 OpenAI 키 설정
echo 'LLM_API_KEY=sk-...' >> .env

# 2) 의존성 설치 + Prisma 스키마/시드 반영
npm install
npm run prisma:migrate       # 필요시
npm run prisma:seed          # 기본 카테고리 + 기본 준비물 48건 반영

# 3) 서버 기동
npm run start:dev

# 4) 맞춤형 체크리스트 생성
curl -X POST http://localhost:8080/api/checklists/generate/1
```

응답은 위 5-3 형식의 JSON.

---

## 7. 설계 포인트 & 트레이드오프

### 왜 INSERT 를 생략했나
- 체크리스트 생성 → 사용자 편집 → 확정 저장의 UX 플로우를 감안, 한 번의 API 호출로 DB 영속화까지 하면 편집 시 레코드 삭제/재생성 비용 발생
- `generateForTrip()` 은 **순수 함수 성격** 으로 유지해서 프리뷰/재생성/저장 엔드포인트 모두에서 재사용 가능

### 왜 마이그레이션을 새로 안 만들었나
- 기존 `ChecklistItemTemplate` / `ChecklistCategory` 모델이 이미 요구사항에 충분. 카테고리 code 3개, `conditions` JSON, `isEssential` 플래그까지 확장 여지가 있었음
- 스키마 변경 없이 **시드만으로 요구사항 충족** → PR 리뷰/롤백 부담 최소화

### 왜 countryId=null 공통 템플릿으로 저장했나
- 요청은 "기본" 준비물 (나라 무관) 이 핵심. 나라별 특수 항목은 OpenAI 추천이나 향후 `countryId` 가 있는 추가 템플릿으로 보강 가능

### 방어 코드 요약
- LLM 응답이 깨져도 기본 체크리스트는 반드시 반환 (try/catch + fallback)
- LLM 이 정의되지 않은 카테고리/타입을 뱉어도 enum 범위로 강등
- 중복 항목은 서버에서 한번 더 필터

### 보완/확장 아이디어 (이 커밋 범위 밖)
- `POST /api/checklists/generate/:tripId/persist` — 프리뷰 결과를 실제 `Checklist` + `ChecklistItem` 로 INSERT (`LlmGeneration` 로그도 함께 기록)
- 국가별/도시별 특수 템플릿 추가 (예: JP → 엔화 환전 리마인더, 동남아 → 모기 기피제 기본 포함 등)
- BullMQ 큐로 OpenAI 호출을 비동기 처리 (현재는 동기 호출, 응답까지 1~3초 소요)
- 프롬프트 버전 관리(Prompt A/B 테스트) — `LlmGeneration.model` 과 함께 `promptVersion` 저장

---

## 8. 작업 중 사소한 이슈

초기 `npm install` 호출 시 shell 의 `working_directory` 파라미터가 실제 셸의 CWD 를 변경하지 않아, 설치가 워크스페이스 루트(`/Users/reallies/Documents/GitHub/checkmate/`) 에 수행되어 루트에 불필요한 `package.json`/`package-lock.json`/`node_modules` 가 생성되는 문제가 있었다. `cd` 를 명령어 안에 직접 포함시키는 방식으로 전환해 해결했고, 루트에 생성된 파일은 모두 정리 완료. 최종적으로는 `checkmate-backend/package.json` 에 `openai@^4.104.0` 만 dependencies 에 추가된 깨끗한 상태.
