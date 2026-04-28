# Checkmate API 명세

## 개요

| 항목 | 내용 |
|------|------|
| 프레임워크 | NestJS 11 + TypeScript |
| API Prefix | `/api` (환경변수 `API_PREFIX`로 변경 가능) |
| 기본 포트 | `8080` |
| DB | PostgreSQL + Prisma ORM |
| 인증 | Supabase JWT (HS256 / ES256) |
| 속도 제한 | 기본 60 req / 60 s (엔드포인트별 별도 설정 가능) |

---

## 인증

### 보호된 엔드포인트

모든 보호된 엔드포인트는 `Authorization` 헤더가 필요합니다.

```
Authorization: Bearer <supabase-jwt-token>
```

- JWT 검증 후 `req.user`에 `AuthUser` 객체를 주입합니다.
- `@Public()` 데코레이터가 붙은 엔드포인트는 토큰 없이 접근 가능합니다.
- 개발 환경에서는 `AUTH_DEV_BYPASS=true` 설정 시 `dev-anon` 사용자로 우회 가능합니다.

### JIT 프로비저닝

최초 로그인 시 `users` + `user_auth_providers` 테이블에 사용자 레코드를 자동 생성합니다.

---

## 공통 오류 응답 형식

```json
{
  "success": false,
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  },
  "path": "/api/...",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

> BigInt 타입의 ID는 모두 **문자열**로 직렬화됩니다.

---

## 모듈별 엔드포인트

---

## 1. Auth (`/auth`)

### GET `/auth/health`

서비스 헬스 체크

- **인증**: 불필요 (Public)

**응답 예시**
```json
{ "ok": true, "service": "auth" }
```

---

### GET `/auth/me`

현재 로그인 사용자의 세션 정보 및 프로필 조회

- **인증**: 선택적 (JWT 없어도 접근 가능, null 반환)

**응답 예시**
```json
{
  "user": {
    "supabaseId": "uuid",
    "email": "user@example.com",
    "provider": "google",
    "profile": {
      "id": "12345",
      "email": "user@example.com",
      "nickname": "홍길동",
      "profileImageUrl": "https://...",
      "gender": "MALE",
      "birthDate": "1990-01-01",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `provider` | `"google" \| "kakao" \| null` | 소셜 로그인 제공자 |
| `gender` | `"MALE" \| "FEMALE" \| "OTHER" \| null` | 성별 |
| `profile` | `object \| null` | 아직 온보딩 미완료 시 null |

---

## 2. Users (`/users`)

### GET `/users/:id`

사용자 정보 조회

- **인증**: 필요
- **Path Params**: `id` (number)

---

### PATCH `/users/me`

내 프로필 업데이트 (온보딩)

- **인증**: 필요

**Request Body**
```json
{
  "nickname": "홍길동",
  "gender": "MALE",
  "birthDate": "1990-01-01",
  "profileImageUrl": "https://example.com/profile.jpg"
}
```

| 필드 | 타입 | 제약 | 필수 |
|------|------|------|------|
| `nickname` | string | 1~30자 | 선택 |
| `gender` | `"MALE" \| "FEMALE" \| "OTHER"` | - | 선택 |
| `birthDate` | string | ISO8601 날짜 (`YYYY-MM-DD`) | 선택 |
| `profileImageUrl` | string | 최대 500자 | 선택 |

**응답 예시**
```json
{
  "user": {
    "id": "12345",
    "email": "user@example.com",
    "nickname": "홍길동",
    "profileImageUrl": null,
    "gender": "MALE",
    "birthDate": "1990-01-01"
  }
}
```

---

### POST `/users/me/consent`

이용약관 동의 및 마케팅 수신 동의 처리

- **인증**: 필요
- **멱등성**: 중복 호출 안전

**Request Body**
```json
{
  "marketingOptIn": false
}
```

| 필드 | 타입 | 기본값 | 필수 |
|------|------|--------|------|
| `marketingOptIn` | boolean | `false` | 선택 |

**응답 예시**
```json
{
  "ok": true,
  "userId": "12345",
  "acceptedAt": "2024-01-01T00:00:00.000Z",
  "marketingOptIn": false
}
```

---

## 3. Trips (`/trips`)

### GET `/trips`

내 여행 목록 조회

- **인증**: 필요

**응답**: 여행 객체 배열

---

### GET `/trips/:id`

여행 상세 조회

- **인증**: 필요
- **Path Params**: `id` (number)

**응답**: 여행 객체 (도시, 항공편, 동행자, 여행 스타일 포함)

---

### POST `/trips`

새 여행 생성

- **인증**: 필요
- **HTTP Status**: `201 Created`

> `userId`는 JWT에서 자동으로 덮어씌워집니다.

**Request Body**
```json
{
  "countryCode": "VN",
  "title": "베트남 다낭 여행",
  "tripStart": "2024-06-01T00:00:00.000Z",
  "tripEnd": "2024-06-07T00:00:00.000Z",
  "bookingStatus": "PLANNED",
  "status": "ACTIVE",
  "cities": [
    {
      "cityIata": "DAD",
      "orderIndex": 0,
      "visitStart": "2024-06-01T00:00:00.000Z",
      "visitEnd": "2024-06-04T00:00:00.000Z",
      "isAutoSynced": false
    }
  ],
  "flights": [
    {
      "direction": "OUTBOUND",
      "flightNo": "KE461",
      "airline": "대한항공",
      "departureIata": "ICN",
      "arrivalIata": "DAD",
      "departAt": "2024-06-01T09:00:00.000Z",
      "arriveAt": "2024-06-01T12:30:00.000Z"
    }
  ],
  "companions": [
    {
      "companionCode": "friend",
      "hasPet": false
    }
  ],
  "travelStyles": [
    {
      "styleCode": "budget"
    }
  ]
}
```

**cities 필드**

| 필드 | 타입 | 제약 | 필수 |
|------|------|------|------|
| `cityIata` | string | 3자 | `cityId` 없으면 필수 |
| `cityId` | number | - | `cityIata` 없으면 필수 |
| `orderIndex` | number | 0 이상 | 필수 |
| `visitStart` | string | ISO8601 | 선택 |
| `visitEnd` | string | ISO8601 | 선택 |
| `isAutoSynced` | boolean | - | 선택 |

**flights 필드**

| 필드 | 타입 | 제약 | 필수 |
|------|------|------|------|
| `direction` | `"OUTBOUND" \| "RETURN"` | - | 필수 |
| `flightNo` | string | `^[A-Z]{2}\d{1,4}[A-Z]?$` | 필수 |
| `airline` | string | - | 필수 |
| `departureIata` | string | 3자 | 필수 |
| `arrivalIata` | string | 3자 | 필수 |
| `departAt` | string | ISO8601 | 필수 |
| `arriveAt` | string | ISO8601 | 필수 |

**bookingStatus 값**

| 값 | 설명 |
|----|------|
| `PLANNED` | 계획 중 |
| `BOOKED` | 예약 완료 |
| `COMPLETED` | 여행 완료 |
| `CANCELLED` | 취소됨 |

---

### PATCH `/trips/:id`

여행 정보 부분 수정

- **인증**: 필요
- **Path Params**: `id` (number)

**Request Body**: `CreateTripDto`와 동일 구조, 모든 필드 선택적

> 배열 필드(cities, flights 등)를 포함하면 기존 항목을 **전체 교체**합니다.

---

### DELETE `/trips/:id`

여행 소프트 삭제

- **인증**: 필요
- **Path Params**: `id` (number)

**응답**: 삭제된 여행 객체 (실제 DB에서는 삭제되지 않음)

---

## 4. Checklists (`/checklists`)

### GET `/checklists/by-trip/:tripId`

여행의 체크리스트 전체 조회

- **인증**: 필요
- **Path Params**: `tripId` (number)

**응답**: 체크리스트 및 아이템 목록

---

### GET `/checklists/by-trip/:tripId/candidates`

체크리스트 후보 목록 조회 (선택 전 풀)

- **인증**: 필요
- **Path Params**: `tripId` (number)

**오류**: 후보가 아직 생성되지 않은 경우 `404`

---

### POST `/checklists/generate/:tripId`

AI 기반 맞춤 체크리스트 생성

- **인증**: 필요
- **Path Params**: `tripId` (number)
- **속도 제한**: 60초당 5회
- **멱등성**: 동일 tripId 재호출 시 캐시된 결과 반환 (OpenAI 미호출)

**응답**: 후보 아이템을 포함한 `GeneratedChecklist` 객체

---

### POST `/checklists/generate-from-context`

여행 레코드 없이 컨텍스트 기반 체크리스트 미리보기 생성

- **인증**: 필요
- **속도 제한**: 60초당 5회

**Request Body**
```json
{
  "destination": "Vietnam (Da Nang, Hoi An)",
  "durationDays": 7,
  "season": "summer",
  "tripStart": "2024-06-01",
  "companions": ["friend"],
  "purposes": ["sightseeing", "food"]
}
```

| 필드 | 타입 | 제약 | 필수 |
|------|------|------|------|
| `destination` | string | 1~200자 | 필수 |
| `durationDays` | number | 1~365 | 필수 |
| `season` | string | 최대 20자 | 선택 (미입력 시 `tripStart` 기준 자동 추론) |
| `tripStart` | string | `YYYY-MM-DD` | 선택 |
| `companions` | string[] | 최대 10개 | 선택 |
| `purposes` | string[] | 최대 10개 | 선택 |

---

### POST `/checklists/items/:itemId/select`

후보 아이템을 내 체크리스트에 추가

- **인증**: 필요
- **Path Params**: `itemId` (number)

**응답 예시**
```json
{
  "id": "999",
  "isSelected": true,
  "selectedAt": "2024-01-01T00:00:00.000Z"
}
```

---

### POST `/checklists/items/:itemId/deselect`

내 체크리스트에서 아이템 제거 (후보 풀에는 유지)

- **인증**: 필요
- **Path Params**: `itemId` (number)

**응답 예시**
```json
{
  "id": "999",
  "isSelected": false,
  "selectedAt": null
}
```

---

### POST `/checklists/by-trip/:tripId/items`

체크리스트 아이템 일괄 upsert

- **인증**: 필요
- **Path Params**: `tripId` (number)

**Request Body**
```json
{
  "items": [
    {
      "title": "여권",
      "description": "유효기간 6개월 이상 확인",
      "categoryCode": "documents",
      "prepType": "pre_departure_check",
      "baggageType": "carry_on",
      "source": "template",
      "orderIndex": 0
    }
  ]
}
```

| 필드 | 타입 | 값 | 필수 |
|------|------|----|------|
| `title` | string | 1~200자 | 필수 |
| `description` | string | 최대 1000자 | 선택 |
| `categoryCode` | string | `clothing`, `documents`, `electronics` 등 | 필수 |
| `prepType` | string | `item` \| `pre_booking` \| `pre_departure_check` \| `ai_recommend` | 필수 |
| `baggageType` | string | `carry_on` \| `checked` \| `none` | 필수 |
| `source` | string | `template` \| `llm` \| `user_added` | 필수 |
| `orderIndex` | number | 0 이상 | 필수 |

> title 기준으로 매칭하여 upsert 처리, 최대 500개

---

### PATCH `/checklists/items/:itemId`

아이템 개별 수정

- **인증**: 필요
- **Path Params**: `itemId` (number)

**Request Body**
```json
{
  "title": "수정된 아이템명",
  "description": "수정된 설명",
  "orderIndex": 2
}
```

모든 필드 선택적. 수정 이력이 `ChecklistItemEdit` 테이블에 기록됩니다.

---

### DELETE `/checklists/items/:itemId`

아이템 소프트 삭제

- **인증**: 필요
- **Path Params**: `itemId` (number)

삭제 이력이 `ChecklistItemEdit` 테이블에 기록됩니다.

---

### POST `/checklists/items/:itemId/check`

아이템 체크/언체크

- **인증**: 필요
- **Path Params**: `itemId` (number)

**Request Body**
```json
{
  "action": "checked"
}
```

| `action` | 설명 |
|----------|------|
| `"checked"` | 완료 처리 |
| `"unchecked"` | 완료 취소 |

체크 이력이 `ChecklistItemCheck` 테이블에 기록됩니다.

---

## 5. LLM (`/llm`)

### POST `/llm/trips/:tripId/generate`

여행 기반 LLM 생성 요청 (비동기 큐)

- **인증**: 필요
- **Path Params**: `tripId` (number)

**Request Body**
```json
{
  "countryCode": "VN",
  "cityCodes": ["DAD", "HOI"],
  "companions": ["friend"],
  "styles": ["budget"],
  "durationDays": 7,
  "tripStart": "2024-06-01T00:00:00.000Z",
  "tripEnd": "2024-06-07T00:00:00.000Z"
}
```

**응답 예시**
```json
{
  "id": "1001",
  "tripId": "42",
  "promptInput": {},
  "model": "gpt-4o-mini",
  "status": "pending",
  "generatedAt": null
}
```

| `status` | 설명 |
|----------|------|
| `pending` | 생성 대기 중 |
| `completed` | 생성 완료 |
| `failed` | 생성 실패 |

---

### GET `/llm/trips/:tripId/generations`

여행의 LLM 생성 이력 조회

- **인증**: 필요
- **Path Params**: `tripId` (number)

**응답**: 생성 레코드 배열 (최신순)

---

## 6. Master (`/master`)

모든 엔드포인트는 인증 없이 접근 가능합니다.

### GET `/master/countries`

지원 국가 목록 조회

**응답 예시**
```json
[
  { "id": "1", "code": "VN", "name": "베트남" }
]
```

---

### GET `/master/cities`

도시 목록 조회

**Query Params**

| 파라미터 | 타입 | 설명 |
|----------|------|------|
| `countryId` | string (BigInt) | 국가 ID로 필터링 |
| `onlyServed` | `"true" \| "false"` | 서비스 지원 도시만 필터링 |

---

### GET `/master/checklist-categories`

체크리스트 카테고리 목록 조회

**응답 예시**
```json
[
  { "code": "documents", "name": "서류", "icon": "📄" }
]
```

---

### GET `/master/travel-styles`

여행 스타일 목록 조회

**응답 예시**
```json
[
  { "code": "budget", "label": "알뜰 여행" }
]
```

---

### GET `/master/companion-types`

동행자 유형 목록 조회

**응답 예시**
```json
[
  { "code": "friend", "label": "친구" }
]
```

---

## 7. Analytics (`/analytics`)

### POST `/analytics/events`

사용자 이벤트 수집 (단건 또는 일괄)

- **인증**: 필요
- **HTTP Status**: `202 Accepted`

**Request Body** (단건 또는 배열)
```json
{
  "userId": "12345",
  "tripId": "42",
  "itemId": null,
  "sessionId": "session-abc-123",
  "eventType": "CHECKLIST_ITEM_CHECKED",
  "metadata": { "source": "swipe" },
  "occurredAt": "2024-01-01T00:00:00.000Z"
}
```

| 필드 | 타입 | 필수 |
|------|------|------|
| `userId` | string \| number | 필수 |
| `tripId` | string \| number \| null | 선택 |
| `itemId` | string \| number \| null | 선택 |
| `sessionId` | string | 필수 |
| `eventType` | UserEventType enum | 필수 |
| `metadata` | object | 선택 |
| `occurredAt` | ISO8601 | 선택 (미입력 시 서버 시간) |

> 비동기 처리 — 응답은 수집 확인만 의미하며 처리 완료를 보장하지 않습니다.

---

## 8. Guide Archives

### GET `/trips/:tripId/guide-archives`

여행의 저장된 가이드 목록 조회

- **인증**: 필요
- **Path Params**: `tripId` (number)

---

### POST `/trips/:tripId/guide-archives`

가이드 스냅샷 저장

- **인증**: 필요
- **HTTP Status**: `201 Created`
- **Path Params**: `tripId` (number)

**Request Body**
```json
{
  "name": "다낭 여행 가이드 v1",
  "snapshot": {}
}
```

---

### PATCH `/guide-archives/:archiveId`

저장된 가이드 수정

- **인증**: 필요
- **Path Params**: `archiveId` (number)

**Request Body**
```json
{
  "name": "수정된 가이드명",
  "snapshot": {}
}
```

---

### DELETE `/guide-archives/:archiveId`

저장된 가이드 삭제

- **인증**: 필요
- **Path Params**: `archiveId` (number)

---

## 엔드포인트 요약

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/auth/health` | ✗ | 헬스 체크 |
| GET | `/auth/me` | 선택 | 현재 사용자 정보 |
| GET | `/users/:id` | ✓ | 사용자 조회 |
| PATCH | `/users/me` | ✓ | 내 프로필 수정 |
| POST | `/users/me/consent` | ✓ | 약관 동의 |
| GET | `/trips` | ✓ | 여행 목록 |
| GET | `/trips/:id` | ✓ | 여행 상세 |
| POST | `/trips` | ✓ | 여행 생성 |
| PATCH | `/trips/:id` | ✓ | 여행 수정 |
| DELETE | `/trips/:id` | ✓ | 여행 삭제 |
| GET | `/checklists/by-trip/:tripId` | ✓ | 체크리스트 조회 |
| GET | `/checklists/by-trip/:tripId/candidates` | ✓ | 후보 목록 조회 |
| POST | `/checklists/generate/:tripId` | ✓ | AI 체크리스트 생성 |
| POST | `/checklists/generate-from-context` | ✓ | 컨텍스트 기반 생성 |
| POST | `/checklists/items/:itemId/select` | ✓ | 아이템 선택 |
| POST | `/checklists/items/:itemId/deselect` | ✓ | 아이템 선택 해제 |
| POST | `/checklists/by-trip/:tripId/items` | ✓ | 아이템 일괄 upsert |
| PATCH | `/checklists/items/:itemId` | ✓ | 아이템 수정 |
| DELETE | `/checklists/items/:itemId` | ✓ | 아이템 삭제 |
| POST | `/checklists/items/:itemId/check` | ✓ | 아이템 체크/언체크 |
| POST | `/llm/trips/:tripId/generate` | ✓ | LLM 생성 요청 |
| GET | `/llm/trips/:tripId/generations` | ✓ | LLM 생성 이력 |
| GET | `/master/countries` | ✗ | 국가 목록 |
| GET | `/master/cities` | ✗ | 도시 목록 |
| GET | `/master/checklist-categories` | ✗ | 체크리스트 카테고리 |
| GET | `/master/travel-styles` | ✗ | 여행 스타일 |
| GET | `/master/companion-types` | ✗ | 동행자 유형 |
| POST | `/analytics/events` | ✓ | 이벤트 수집 |
| GET | `/trips/:tripId/guide-archives` | ✓ | 가이드 목록 |
| POST | `/trips/:tripId/guide-archives` | ✓ | 가이드 저장 |
| PATCH | `/guide-archives/:archiveId` | ✓ | 가이드 수정 |
| DELETE | `/guide-archives/:archiveId` | ✓ | 가이드 삭제 |
