# Checkmate Backend — 진행 현황

> 최종 업데이트: 2026-04-20
> 프로젝트: Checkmate (AI 여행 체크리스트) 백엔드
> 리포지토리 구조: 모노레포 (`Checkmate-Frontend/` + `checkmate-backend/`)

---

## 0. Tech Stack 최종 결정

| Layer | Choice | 왜? |
| --- | --- | --- |
| Language | **TypeScript 5** | 프론트(React/JS)와 타입 공유 가능, 엔티티가 많아 DX 필요 |
| Framework | **NestJS 11** | 5개 도메인(user/trip/checklist/llm/analytics)을 모듈 단위 DDD로 분리, Guard/Interceptor/Pipe 표준화, BullMQ·SSE 확장 용이 |
| DB | **PostgreSQL 16** (로컬 Docker, 배포 시 Supabase/Neon 등) | `jsonb` + GIN 인덱스, 네이티브 enum, 부분 인덱스 — ERD의 JSON 중심·enum 다수·로그 테이블 특성에 정합 |
| ORM | **Prisma 6** | 선언형 스키마 + 자동 마이그레이션, `Json` 타입·enum 1급 지원, 중첩 include 타입 안전 |
| Auth | **Supabase Auth** (JWT 검증은 Nest `SupabaseJwtGuard`) | 프론트가 이미 Supabase 키를 전제, 관리형 OAuth(google/kakao) |
| Queue | **BullMQ + Redis** (의존성만 설치, 워커는 미구현) | LLM 비동기 호출 / 이벤트 배치 처리용 |
| Validation | **class-validator + class-transformer** (DTO), **zod** (env) | DTO 는 Nest 표준 파이프, env 는 초기 부팅 시 즉시 실패 |
| Security | **helmet**, CORS 화이트리스트 | 기본 하드닝 |

---

## 1. 지금까지 완료한 것

### Phase 1 — 프로젝트 스캐폴드 & Prisma 스키마

완전한 NestJS 프로젝트 구조를 `checkmate-backend/` 에 구축했다.

- `package.json` — Nest 11, Prisma 6, Supabase, BullMQ, zod 등 의존성 **760 packages 설치 완료**
- `tsconfig.json` / `tsconfig.build.json` — strict 모드, 경로 alias (`@/`, `@common/` 등)
- `nest-cli.json`, `.eslintrc.cjs`, `.prettierrc`
- `.env.example` + `.env` — 앱/DB/Supabase/Redis/LLM 환경변수 그룹
- `README.md` — 스택, 디렉토리 구조, API 표, 로컬 실행 가이드
- `prisma/schema.prisma` — **ERD 전체 14개 모델 + 13개 enum** 매핑
  - 모든 컬럼 `@map` 으로 snake_case↔camelCase 규칙
  - `@unique`, `@@unique`, `@@index`, `deletedAt` 인덱스
  - `BigInt` 기본 키 + JSON 직렬화 패치(`main.ts` 에서 `BigInt.prototype.toJSON`)
  - `Json` 컬럼: `checklist_item_templates.conditions`, `guide_archives.snapshot`, `checklist_item_edits.before_value/after_value`, `llm_generations.prompt_input/response_raw`, `user_events.metadata`
- `prisma/seed.ts` — idempotent upsert 로 마스터 데이터 42 row 시드
  - countries 10 (KR, JP, TW, VN, TH, US, FR, IT, ES, GB)
  - cities 10 (주요 취항지 IATA 포함)
  - checklist_categories 8 (documents…ai_recommend)
  - travel_styles 8 (foodie…nightlife)
  - companion_types 6 (alone…pets)

**검증**: `npx tsc --noEmit` 통과 · `nest build` 통과 · 린터 에러 0.

### Phase 2 — 코어 레이어 구성

도메인 코드가 자라도 변하지 않는 공통 기반을 먼저 세웠다.

- `src/main.ts` — ValidationPipe(whitelist/transform), Helmet, CORS, BigInt JSON 패치
- `src/app.module.ts` — ConfigModule 전역화 + 7개 도메인 모듈 조립
- `src/config/configuration.ts` + `validation.ts` — zod 스키마로 **부팅 시 env 검증**
- `src/common/`
  - `decorators/public.decorator.ts` — `@Public()` 로 Guard 우회
  - `decorators/current-user.decorator.ts` — `@CurrentUser()` 로 req.user 주입 꺼내기
  - `guards/supabase-jwt.guard.ts` — HS256 JWT 검증 (의존성 없이 crypto로 구현). **dev 모드 + secret 미설정 시 자동 바이패스** (프론트 연동 전 수동 테스트 용이)
  - `interceptors/logging.interceptor.ts` — 요청 메서드/경로/소요시간 로깅
  - `filters/http-exception.filter.ts` — 표준 에러 응답 스키마 (`{success, error:{code,message,details}, path, timestamp}`)
- `src/infra/`
  - `prisma/prisma.service.ts` + `prisma.module.ts` — `@Global()`, lifecycle hooks
  - `supabase/supabase.service.ts` + `supabase.module.ts` — 서비스 롤 키 기반 admin 클라이언트(지연 초기화)

### Phase 3 — 도메인 모듈 뼈대

ERD의 도메인 경계(`USER / MASTER / TRIP / CHECKLIST / LLM / ANALYTICS`)와 1:1 매핑되는 7개 NestJS 모듈을 생성했다.

| 모듈 | 구현 수준 | 제공 엔드포인트 |
| --- | --- | --- |
| `auth` | 컨트롤러만 | `GET /auth/health`, `GET /auth/me` |
| `users` | 컨트롤러+서비스 | `GET /users/:id` (soft-delete 필터) |
| `master` | 컨트롤러+서비스 (모두 `@Public()`) | countries/cities/checklist-categories/travel-styles/companion-types 5종 조회 |
| `trips` | **완전 구현 (Phase 5 참고)** | list/get/create/patch/softDelete |
| `checklists` | 최소 스켈레톤 | `GET /checklists/by-trip/:tripId` |
| `llm` | 최소 스켈레톤 + DB enqueue | `POST /llm/trips/:tripId/generate` (llm_generations 레코드 생성, pending 상태), `GET …/generations` |
| `analytics` | 단건/배열 이벤트 수집 | `POST /analytics/events` (HttpCode 202) |

### Phase 4 — 로컬 DB 환경

- `docker-compose.yml` — Postgres 16-alpine (5432), Redis 7-alpine (6379), 둘 다 healthcheck + 영구 볼륨
- `.env` 의 `DATABASE_URL` / `DIRECT_URL` 을 로컬 Docker 로 기입
- `docker compose up -d` → 두 컨테이너 `(healthy)` 확인
- `npx prisma migrate dev --name init` 실행 → **`prisma/migrations/20260420145309_init/migration.sql` 생성 및 적용** (이 파일은 git에 커밋되어 모든 환경에 재현 가능)
- `npx ts-node --transpile-only prisma/seed.ts` → 42 row 시드 성공
- 실 DB 스모크 테스트:
  - `GET /api/auth/health` → `{"ok":true,"service":"auth"}`
  - `GET /api/master/countries` → 10건 정상 반환
  - `GET /api/master/checklist-categories` → 8건 반환
  - BigInt 가 문자열로 직렬화 (`id:"3"`) 되는 것 확인 — 프론트 Number 범위 이슈 차단

### Phase 5 — Trip 생성/수정/삭제 API (완전 구현)

프론트의 `/trips/new/destination` → `Step2` → `Step3` → `Step4` → `Step5` 플로우를 한 번의 POST 로 커밋할 수 있도록 구현.

**추가된 파일**
- `src/modules/trips/dto/create-trip.dto.ts` — 중첩 DTO 5종 (CreateTripDto, TripCityInputDto, TripFlightInputDto, TripCompanionInputDto, TripTravelStyleInputDto), class-validator 제약 + `flightNo` 정규식 포함
- `src/modules/trips/dto/update-trip.dto.ts` — 부분 업데이트용 (배열은 전체 교체 시맨틱)
- `src/modules/trips/trips.service.ts` — 재작성
- `src/modules/trips/trips.controller.ts` — POST/PATCH/DELETE 추가
- `src/common/guards/supabase-jwt.guard.ts` — dev 바이패스 순서 교정 (헤더 없어도 dev-anon 주입)

**핵심 설계 결정**
1. **프론트 친화 식별자** — `countryCode`(alpha-2), `cityIata`, `companionCode`, `styleCode` 로 받아 백엔드가 ID로 매핑. 프론트 mock 의 `id:'couple'`, `iata:'DAD'` 를 그대로 전송 가능.
2. **단일 트랜잭션** — `$transaction` 안에서 `trip` + `trip_cities` + `trip_flights` + `trip_companions` + `trip_travel_styles` 를 `createMany` 로 원자적 생성.
3. **PATCH = 부분 수정 + 배열 전체 교체** — 배열 필드를 보내면 `deleteMany → createMany` 로 해당 관계 통째 교체. 안 보내면 그대로 유지.
4. **Soft delete** — `trip.deleted_at` 만 세팅. 연관 로그 테이블(`checklist_item_edits`, `user_events`) 은 보존.
5. **비즈니스 검증 5종**
   - `tripStart > tripEnd` 차단
   - `bookingStatus=not_booked` 인데 flights 전달 차단
   - `flightNo` 정규식 `^[A-Z]{2}\d{1,4}[A-Z]?$` (KE101/VN401/OZ851 허용)
   - 항공편 `departAt > arriveAt` 차단
   - `cities[*].orderIndex` 중복 차단

**엔드투엔드 검증 결과 (실제 DB 왕복)**

| # | 시나리오 | 결과 |
| --- | --- | --- |
| 1 | POST /trips (full payload) | ✅ 201, trip + 2 cities + 2 flights + 1 companion + 2 styles |
| 2 | 잘못된 countryCode ZZ | ✅ 400 |
| 3 | orderIndex 중복 | ✅ 400 |
| 4 | not_booked + flights 동시 | ✅ 400 |
| 5 | flightNo 패턴 오류 | ✅ 400 (전역 ValidationPipe) |
| 6 | GET /trips?userId=1 | ✅ 200 |
| 7 | GET /trips/1 (include all) | ✅ 200 |
| 8 | PATCH — title/status + cities 2→1 교체 | ✅ 200 (기존 row 삭제 후 재삽입 확인) |
| 9 | DELETE /trips/1 | ✅ 200 soft delete |
| 10 | 삭제 후 GET | ✅ 404 |
| 11 | DB 직접 조회 검증 | ✅ `deleted_at` 세팅 / 연관 row 보존 |

---

## 2. 현재 디렉토리 구조

```text
checkmate-backend/
├── docker-compose.yml            # Postgres + Redis (local dev)
├── .env / .env.example
├── package.json / tsconfig.*.json / nest-cli.json
├── prisma/
│   ├── schema.prisma             # SSoT — 14 모델 + 13 enum
│   ├── seed.ts                   # 마스터 데이터 42 row
│   └── migrations/
│       └── 20260420145309_init/  # git 커밋됨 → 모든 환경 재현 가능
│           └── migration.sql
├── src/
│   ├── main.ts                   # bootstrap, ValidationPipe, Helmet, CORS, BigInt JSON
│   ├── app.module.ts
│   ├── common/
│   │   ├── decorators/           # Public, CurrentUser
│   │   ├── filters/              # 표준 에러 응답
│   │   ├── guards/               # SupabaseJwtGuard (HS256)
│   │   └── interceptors/         # Logging
│   ├── config/
│   │   ├── configuration.ts      # typed config loader
│   │   └── validation.ts         # zod env 검증 (부팅 시)
│   ├── infra/
│   │   ├── prisma/
│   │   └── supabase/
│   └── modules/
│       ├── auth/                 # health, me
│       ├── users/                # getOne
│       ├── master/               # 5 public 조회 엔드포인트
│       ├── trips/                # ✅ 완전 CRUD (DTO, Service, Controller)
│       │   └── dto/
│       ├── checklists/           # 스켈레톤
│       ├── llm/                  # DB enqueue (워커 미구현)
│       └── analytics/            # 이벤트 수집 (단건/배열)
└── README.md
```

---

## 3. 현재 API 표

| Method | Path | 설명 | 공개 |
| --- | --- | --- | --- |
| GET | `/api/auth/health` | 헬스체크 | ✅ |
| GET | `/api/auth/me` | 현재 사용자(JWT sub) | 🔐 |
| GET | `/api/users/:id` | 사용자 상세 | 🔐 |
| GET | `/api/master/countries` | 국가 목록 | ✅ |
| GET | `/api/master/cities?countryId=&onlyServed=` | 도시 목록 | ✅ |
| GET | `/api/master/checklist-categories` | 카테고리 | ✅ |
| GET | `/api/master/travel-styles` | 여행 스타일 | ✅ |
| GET | `/api/master/companion-types` | 동행 유형 | ✅ |
| GET | `/api/trips?userId=` | 유저 trip 목록 (soft-delete 제외) | 🔐 |
| GET | `/api/trips/:id` | trip 상세 (관계 include) | 🔐 |
| POST | `/api/trips` | **trip + 관계 원자적 생성** | 🔐 |
| PATCH | `/api/trips/:id` | 부분 수정 / 배열 필드는 전체 교체 | 🔐 |
| DELETE | `/api/trips/:id` | Soft delete | 🔐 |
| GET | `/api/checklists/by-trip/:tripId` | 체크리스트 조회 | 🔐 |
| POST | `/api/llm/trips/:tripId/generate` | LLM 생성 enqueue (pending 기록) | 🔐 |
| GET | `/api/llm/trips/:tripId/generations` | 생성 이력 | 🔐 |
| POST | `/api/analytics/events` | 이벤트 수집 (단건/배열 모두 지원) | 🔐 |

dev 모드에서는 `SUPABASE_JWT_SECRET` 미설정이면 🔐 표시 엔드포인트도 `dev-anon` 으로 통과.

---

## 4. 현재 상태 체크리스트

| 항목 | 상태 |
| --- | --- |
| 프로젝트 스캐폴드 | ✅ |
| Prisma 스키마 (ERD 전체) | ✅ |
| 마이그레이션 `init` 생성·적용 | ✅ git 커밋됨 |
| 마스터 데이터 시드 | ✅ 42 rows |
| `docker compose up -d` (Postgres+Redis) | ✅ 두 컨테이너 `(healthy)` |
| TypeScript 타입 체크 / nest build | ✅ 에러 0 |
| Trip CRUD 엔드투엔드 | ✅ 11개 시나리오 통과 |
| Supabase Auth 실제 연동 | ⏳ (dev 바이패스로 임시 통과) |
| Checklist 아이템 CRUD | ⏳ 스켈레톤만 |
| LLM 실제 호출(OpenAI/Anthropic) | ⏳ DB enqueue 까지만 |
| BullMQ 워커 구성 | ⏳ 의존성만 설치 |
| 이벤트 로깅 Interceptor 자동화 | ⏳ |
| 단위/e2e 테스트 | ⏳ |
| 프론트와 실제 연동 | ⏳ |
| 배포 환경 세팅 | ⏳ (가이드는 README 에 있음) |

---

## 5. 다음에 진행할 사항 (우선순위 순)

### 🥇 NEXT-1. 프론트 ↔ 백엔드 실제 연동 (권장)

이유: Trip API 까지 만들어졌으므로 실제 프론트 Step5 "계획 생성" 버튼이 현재 **작동 안 함**. 가장 ROI 큼.

**세부 태스크**
1. `Checkmate-Frontend/.env.local` 에 `VITE_API_BASE_URL=http://localhost:8080/api` 설정
2. `Checkmate-Frontend/src/api/` 디렉토리 신설
   - `client.js` — axios 인스턴스 (baseURL, 공통 에러 인터셉터, 향후 JWT 헤더 자동 첨부)
   - `trips.js` — `createTrip(payload)`, `getTrip(id)`, `listTrips(userId)`, `updateTrip(id, payload)`, `deleteTrip(id)`
   - `master.js` — `getCountries()`, `getCities({countryId, onlyServed})`, `getCompanionTypes()`, `getTravelStyles()`, `getChecklistCategories()`
   - `analytics.js` — `trackEvent(event)` (프론트 로컬 이벤트 수집 → 배치 플러시)
3. `TripNewStep5Page` 의 "계획 생성" 핸들러를 `createTrip({countryCode, title, tripStart, tripEnd, bookingStatus, cities, flights, companions, travelStyles})` 로 연결
4. `tripPlanContextStorage` / `tripFlowDraftStorage` 에 쌓인 드래프트를 API payload 로 조립하는 어댑터 함수 작성
5. 성공 시 `/trips/:id/checklist` 로 라우팅 + `clearActiveTripPlan()`
6. **마스터 데이터 동기화** — 프론트 하드코딩된 `TRAVEL_STYLES`, `COMPANIONS`, `CITY_IMAGES` 를 실제 API 조회로 점진 치환(우선 렌더만 바꾸고 이미지 매핑은 유지)
7. CORS 검증: 현재 `.env` 의 `CORS_ORIGIN=http://localhost:5173` 이 Vite 포트와 맞는지 확인

### 🥈 NEXT-2. Checklist 아이템 CRUD + 자동 편집 로깅

이유: ERD 의 `checklist_items`, `checklist_item_edits`, `checklist_item_checks` 는 OKR 지표 수집의 핵심 (프론트 `TripChecklistPage` 의 dnd-kit 기반 정렬, 체크 토글 UX 에 대응).

**세부 태스크**
1. DTO — `CreateChecklistItemDto`, `UpdateChecklistItemDto`, `ReorderItemsDto`, `ToggleCheckDto`
2. 엔드포인트 (컨트롤러)
   - `POST   /checklists/:checklistId/items` — 수동 추가 (source=`user_added`)
   - `PATCH  /checklist-items/:id` — title/description/detail/prepType/baggageType 수정 → `edit_type=text`
   - `DELETE /checklist-items/:id` — soft delete → `edit_type=del`
   - `PATCH  /checklist-items/:id/check` — `isChecked` 토글 + `checked_at` 기록
   - `POST   /checklists/:checklistId/items/reorder` — 일괄 orderIndex 갱신 → `edit_type=reorder`
3. **자동 로깅 전략** (중요)
   - 옵션 A: 서비스 내부에서 트랜잭션 안에 직접 `checklist_item_edits.create` 호출 (단순, 권장)
   - 옵션 B: Nest `EventEmitter2` + listener 로 비동기 기록
   - → 옵션 A 선택. 편집 전 `before_value` / 후 `after_value` 를 JSON snapshot 으로 저장.
4. `completionRate` 재계산 — 체크 토글 때마다 `checklists.completionRate` 업데이트 (`checked / total * 100`)
5. Trip 상태 자동 전이 — `completionRate=100` 이면 `checklists.status=completed`, `trips.status=preparing→completed` 로직(선택)
6. 검증 — 같은 `checklist_id` 내에서 `order_index` unique 보장 (현재 unique constraint 없음, 서비스 레이어에서만 체크)

### 🥉 NEXT-3. 인증 실제 결합 (Supabase)

dev 바이패스를 제거하고, 실제 JWT → DB 사용자 매핑까지 뚫기.

**세부 태스크**
1. Supabase 프로젝트 생성 (무료 티어) → URL / anon key / service role key / JWT secret 확보
2. `.env` 에 실제 값 기입 — `SUPABASE_JWT_SECRET` 설정하면 Guard 가 자동으로 실제 검증 모드로 전환
3. `SupabaseJwtGuard` 고도화
   - 프로덕션에선 `jose` 라이브러리 + JWKS 캐시로 교체(현재는 의존성 없는 HS256 최소 구현)
   - JWT `sub`(Supabase UUID) → `users` 테이블 매핑
     - `user_auth_providers.provider_user_id = sub` 로 찾거나
     - 없으면 **JIT 프로비저닝** (처음 로그인 시 `users` + `user_auth_providers` row 자동 생성)
   - `req.user.userId` (BigInt) 주입
4. 컨트롤러들에서 `userId` 를 body/query 대신 `@CurrentUser()` 로 받도록 변경
   - `CreateTripDto.userId` 제거
   - `GET /trips?userId=` 를 `GET /trips` (본인 것만) 으로
5. 프론트 — Supabase client(`@supabase/supabase-js`) 로 로그인 후 `session.access_token` 을 axios 인터셉터에서 `Authorization: Bearer` 헤더로 자동 첨부

### 4. LLM 비동기 워커 (BullMQ + OpenAI/Anthropic)

ERD 의 `llm_generations.status` 가 `pending/success/failed` 인 이유 = **비동기 처리 전제**. Trip 생성 완료 시 자동으로 LLM 큐에 enqueue → 워커가 호출 → 결과를 `checklist` + `checklist_items` 로 펼쳐 저장.

**세부 태스크**
1. `src/infra/redis/redis.module.ts` — BullMQ connection 설정 (`@nestjs/bullmq` 이미 설치됨)
2. `src/jobs/llm-generate.processor.ts` — `@Processor('llm-generate')` 워커
   - pending row 를 읽어 프롬프트 조립 (country/cities/companions/styles/duration)
   - LLM provider 호출 (`openai` 기본, `anthropic` 옵션, `LLM_PROVIDER` env 분기)
   - 응답 파싱 → `checklists` + `checklist_items` 배치 insert (source=`llm`)
   - `llm_generations.status` → success/failed, `tokens_used` 저장
3. `LlmService.requestChecklist` 를 큐 enqueue 로 전환 (`Queue.add`)
4. 프롬프트 템플릿 — 카테고리 8종, 필수 항목, conditions(weather/season/companion) 반영
5. **Trip 생성 훅** — `TripsService.create` 가 성공하면 자동으로 LLM enqueue (옵션: `autoGenerate:true` 파라미터)
6. 스트리밍(선택) — `POST /llm/trips/:tripId/stream` SSE 로 토큰 단위 응답 푸시
7. 비용 제한 — 유저별 일 LLM 호출 횟수 rate limit (Redis)

### 5. 이벤트 수집 자동화 & OKR 집계

프론트가 모든 이벤트를 수동 `trackEvent()` 호출하지 않아도 되도록 백엔드에서 **추론 가능한 이벤트는 Interceptor 가 자동 기록**.

**세부 태스크**
1. `UserEventInterceptor` — 메서드·경로·응답 코드 매핑 테이블로 자동 이벤트 생성
   - 예: `PATCH /checklist-items/:id` → `edit_text`
   - 예: `POST /checklists/:id/items/reorder` → `edit_reorder`
   - 예: `POST /checklists/:id/items` → `edit_add`
   - 예: `DELETE /checklist-items/:id` → `edit_del`
2. `session_id` — 프론트가 헤더 `X-Session-Id` 로 전달 (30분 inactivity 규칙은 프론트에서)
3. OKR 집계 전용 쿼리 뷰 (raw SQL 마이그레이션)
   - `daily_active_users`
   - `search_to_save_conversion_rate`
   - `checklist_completion_rate_p50`
   - `llm_missing_item_detection_count`
4. 주기 배치 — BullMQ repeatable job 으로 매일 새벽 1회 집계 테이블 갱신

### 6. 테스트 인프라

**세부 태스크**
1. Jest 유닛 테스트 — `TripsService` (매핑 함수, 비즈니스 검증 5종)
2. e2e 테스트 — `test/trips.e2e-spec.ts` — supertest 로 POST→GET→PATCH→DELETE 시퀀스
3. 테스트용 DB 분리 — `DATABASE_URL_TEST` 환경변수 + `beforeAll` 에서 `prisma migrate deploy` + cleanup
4. CI 셋업 — GitHub Actions: `npm install` → `docker compose up -d postgres` → `prisma migrate deploy` → `npm run test:e2e`
5. 커버리지 최소선 — services 70% 이상

### 7. 보조/운영 기능

- Rate limiting — `@nestjs/throttler` (IP 기반 + 유저 기반)
- Swagger / OpenAPI — `@nestjs/swagger` 로 `/api/docs` 자동 생성 (프론트에게 문서 링크 공유)
- Sentry 연동 — 에러 추적
- 로깅 포맷 — `pino` or `nestjs-pino` 로 JSON 구조화 로그 (프로덕션 분석 용이)
- Health check 고도화 — `@nestjs/terminus` 로 DB/Redis/LLM provider 각각 체크 (`GET /health/ready`, `/health/live`)
- `prisma/seed.ts` 확장 — ChecklistItemTemplate (국가별 필수 준비물) 추가, 이후 하이브리드 생성(`template + llm`)의 기반이 됨

### 8. 배포 준비 (나중)

- **DB 호스팅 결정** — Supabase(권장, Auth 와 통합) / Neon / Railway 중 선택
- **앱 호스팅** — Railway / Render / Fly.io 중 선택
- 시작 명령: `npx prisma migrate deploy && node dist/main.js`
- 환경변수 — 플랫폼 설정에 `DATABASE_URL`, `SUPABASE_*`, `LLM_API_KEY`, `REDIS_*` 등록
- 최초 1회 시드 — `npx ts-node --transpile-only prisma/seed.ts` (upsert 라 안전)
- 운영 DB 마이그레이션은 `migrate dev` 절대 금지, `migrate deploy` 만 사용

---

## 6. 알려진 한계 / TODO 메모

- `_prisma_migrations` 는 Prisma 가 자동 관리하므로 ERD 문서에 포함 X (정상).
- `checklist_items.order_index` 에 `@@unique([checklistId, orderIndex])` 제약이 **아직 없음**. 재정렬 중 일시 중복을 허용하기 위해 서비스 레이어에서만 검증. 재정렬 API 구현 시 트랜잭션 + 임시 음수 offset 패턴 검토.
- `BigInt` 를 문자열로 직렬화하므로, 프론트에서 정렬·연산 시 주의 (`BigInt(id)` 변환).
- 현재 `@dnd-kit` 의 드래그 순서 변경 이벤트는 프론트에만 있고, 백엔드 `/reorder` 엔드포인트 미구현 (NEXT-2).
- `guide_archives.snapshot` JSON 스키마는 아직 고정되지 않음. Checklist API 구현 시 함께 정의 필요.
- Supabase 미설정 상태에서는 **모든 엔드포인트가 `dev-anon` 으로 통과** — 배포 전 `SUPABASE_JWT_SECRET` 필수 세팅.

---

## 7. 참고 명령어 모음

```bash
# 로컬 인프라 기동/중지
docker compose up -d
docker compose down           # 볼륨 보존
docker compose down -v        # 볼륨까지 삭제 (DB 초기화)

# Prisma
npx prisma migrate dev --name <name>   # 스키마 변경 시
npx prisma migrate deploy              # 운영 환경
npx prisma studio                      # DB GUI (http://localhost:5555)
npx ts-node --transpile-only prisma/seed.ts

# 개발
npm run start:dev      # HMR
npm run build          # dist/
node dist/main.js      # 프로덕션 모드 실행

# 타입/린트
npx tsc --noEmit
npm run lint
```
