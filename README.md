# Checkmate Backend

Checkmate(AI 여행 체크리스트) 서비스의 백엔드.

## Tech Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript 5 |
| Framework | NestJS 11 |
| Database | PostgreSQL 16 (Supabase 호스팅 가능) |
| ORM | Prisma 6 |
| Auth | Supabase Auth (JWT 검증은 Nest `SupabaseJwtGuard`) |
| Queue | BullMQ + Redis (LLM 비동기 처리) |
| Validation | class-validator + zod (env) |

## Directory Structure

```text
checkmate-backend/
├── prisma/
│   ├── schema.prisma        # 단일 소스 오브 트루스
│   └── seed.ts              # 마스터 데이터 시드
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── common/              # Guard, Interceptor, Filter, Decorator
│   ├── config/              # typed config + zod env 검증
│   ├── infra/               # Prisma, Supabase, Redis
│   └── modules/             # 도메인 모듈 (auth/users/master/trips/checklists/llm/analytics)
└── test/
```

## Getting Started

```bash
# 1) 의존성 설치
npm install

# 2) .env 준비
cp .env.example .env
# DATABASE_URL / SUPABASE_* 를 채운다.

# 3) DB 마이그레이션 & 시드
npm run prisma:migrate -- --name init
npm run prisma:seed

# 4) 개발 서버
npm run start:dev
# -> http://localhost:8080/api
```

## API Surface (초기)

| Method | Path | 설명 | 공개 |
| --- | --- | --- | --- |
| GET | `/api/auth/health` | 헬스체크 | ✅ |
| GET | `/api/auth/me` | 현재 사용자 | 🔐 |
| GET | `/api/master/countries` | 국가 목록 | ✅ |
| GET | `/api/master/cities?countryId=&onlyServed=` | 도시 목록 | ✅ |
| GET | `/api/master/checklist-categories` | 카테고리 | ✅ |
| GET | `/api/master/travel-styles` | 여행 스타일 | ✅ |
| GET | `/api/master/companion-types` | 동행 유형 | ✅ |
| GET | `/api/trips?userId=` | 유저 trip 목록 | 🔐 |
| GET | `/api/trips/:id` | trip 상세 | 🔐 |
| GET | `/api/checklists/by-trip/:tripId` | 체크리스트 | 🔐 |
| POST | `/api/llm/trips/:tripId/generate` | LLM 생성 요청 | 🔐 |
| GET | `/api/llm/trips/:tripId/generations` | LLM 이력 | 🔐 |
| POST | `/api/analytics/events` | 이벤트 수집 (단건/배열) | 🔐 |

## Frontend 연동

프론트(`Checkmate-Frontend/src/config/env.js`)의 `VITE_API_BASE_URL`
을 `http://localhost:8080/api` 로 설정하면 axios 클라이언트가 바로 연결된다.

JWT 는 Supabase Auth 세션에서 `access_token` 을 꺼내
`Authorization: Bearer <token>` 헤더로 전송한다.
