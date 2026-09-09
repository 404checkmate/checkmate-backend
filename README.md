<div align="center">

<img src="https://avatars.githubusercontent.com/u/275568950?s=400&u=fb26e17e18bb6c9aaa44277cbe910638e3922cf9&v=4" width="120" alt="CHECKMATE logo" />

# ♟️ CHECKMATE — Backend

### 준비는 쉽게, 여행은 완벽하게
AI 맞춤 여행 체크리스트 서비스의 백엔드 API 서버 (NestJS 11)

[![Status](https://img.shields.io/badge/🟢_Live-checkmate--v.com-22C55E?style=for-the-badge)](https://checkmate-v.com)
[![Frontend](https://img.shields.io/badge/Frontend-Repo-FBBF24?style=for-the-badge&logo=github&logoColor=white)](https://github.com/404checkmate/Checkmate-Frontend)

<br/>

> 🟢 **운영 중 · Live** — [checkmate-v.com](https://checkmate-v.com) 에서 서비스 중.
> API는 **Render 무료 웹서비스**([api.checkmate-v.com](https://api.checkmate-v.com/api/health)), 데이터는 Supabase.
> AWS 프리티어 종료로 과금이 발생해 2026-09-09 EC2에서 이전했으며, 도메인·데이터를 유지한 채 **서버 비용 $0** 로 상시 가동합니다.
> *Live at checkmate-v.com; API on a Render free web service, data on Supabase. Migrated off AWS EC2 on 2026-09-09 — same domain, same data, $0 server cost.*

</div>

---

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
| LLM | OpenAI (`openai.service.ts`) — 백그라운드 생성 후 상태 폴링 |
| Validation | class-validator + zod (env) |
| Hosting | Render (무료 웹서비스) · `render.yaml` Blueprint · 관리형 TLS |
| CI/CD | `main` 푸시 시 Render 자동 배포 (build → health check → live) |

## Directory Structure

```text
checkmate-backend/
├── render.yaml              # Render Blueprint (배포 구성 IaC)
├── prisma/
│   ├── schema.prisma        # 단일 소스 오브 트루스
│   └── seed.ts              # 마스터 데이터 시드
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── common/              # Guard, Interceptor, Filter, Decorator
│   ├── config/              # typed config + zod env 검증
│   ├── infra/               # Prisma, Supabase
│   └── modules/             # 도메인 모듈 (health/auth/users/master/trips/
│                            #   checklists/llm/guide-archives/analytics/
│                            #   admin-metrics/affiliate-links/friends/notifications)
└── test/
```

## Getting Started

```bash
# 1) 의존성 설치
npm install

# 2) .env 준비 — DATABASE_URL / DIRECT_URL 에 Postgres 연결 문자열 입력
#    운영·개발 DB 는 Supabase PostgreSQL (managed). .env.example 참고.
cp .env.example .env

# 3) DB 마이그레이션 & 마스터 데이터 시드
npx prisma migrate dev --name init
npx ts-node --transpile-only prisma/seed.ts

# 4) 개발 서버
npm run start:dev
# -> http://localhost:8080/api

# 5) 스모크 테스트
curl http://localhost:8080/api/auth/health
curl http://localhost:8080/api/master/countries
```

> 로컬에서 Postgres 를 직접 띄우고 싶다면 `docker compose up -d` 로 컨테이너를 쓸 수 있습니다 (선택). 별도 설정 없이 Supabase `DATABASE_URL` 을 그대로 사용해도 됩니다.

### 주요 스크립트

| 명령 | 설명 |
| --- | --- |
| `docker compose up -d` / `down` | (선택) 로컬 Postgres(5432) 기동/중지 |
| `npx prisma migrate dev` | 스키마 변경 시 새 마이그레이션 생성/적용 |
| `npx prisma studio` | DB GUI (http://localhost:5555) |
| `npx ts-node --transpile-only prisma/seed.ts` | 마스터 데이터 재시드 (idempotent) |
| `npm run start:dev` | Nest dev server (HMR) |
| `npm run build` | `dist/` 로 컴파일 |

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
| GET | `/api/trips?userId=` | 유저 trip 목록 (soft-delete 제외) | 🔐 |
| GET | `/api/trips/:id` | trip 상세 (country/cities/flights/companions/styles/checklist include) | 🔐 |
| POST | `/api/trips` | trip + 관계 한 번에 생성 (단일 트랜잭션) | 🔐 |
| PATCH | `/api/trips/:id` | 부분 수정. 배열 전달 시 해당 관계 전체 교체 | 🔐 |
| DELETE | `/api/trips/:id` | Soft delete (`deleted_at`) | 🔐 |
| GET | `/api/checklists/by-trip/:tripId` | 체크리스트 | 🔐 |
| POST | `/api/llm/trips/:tripId/generate` | LLM 생성 요청 | 🔐 |
| GET | `/api/llm/trips/:tripId/generations` | LLM 이력 | 🔐 |
| POST | `/api/analytics/events` | 이벤트 수집 (단건/배열) | 🔐 |
| GET | `/api/health` | 헬스체크 — DB `SELECT 1` 포함 | ✅ |

## Frontend 연동

프론트(`Checkmate-Frontend/src/config/env.js`)의 `VITE_API_BASE_URL`
을 `http://localhost:8080/api` 로 설정하면 axios 클라이언트가 바로 연결된다.

JWT 는 Supabase Auth 세션에서 `access_token` 을 꺼내
`Authorization: Bearer <token>` 헤더로 전송한다.

운영에서는 프론트(Vercel)의 `vercel.json` 리라이트가 `/api/*` 를
`api.checkmate-v.com/api/*` 로 넘긴다. 백엔드 호스팅이 바뀌어도
이 도메인만 유지하면 프론트는 수정이 필요 없다.

## Deployment

`render.yaml` (Blueprint) 하나로 구성이 재현된다. `main` 에 푸시하면 Render 가 자동 배포한다.

```bash
# build
npm ci --include=dev && npx prisma generate && npm run build
# start
node dist/main.js
```

> 🔴 `--include=dev` 는 생략하면 안 된다. `NODE_ENV=production` 에서 `npm ci` 는 devDependencies 를
> 건너뛰는데, 빌드에 필요한 `@nestjs/cli`(`nest`)·`typescript`·`prisma` 가 모두 devDependency 라
> `sh: 1: nest: not found` 로 빌드가 죽는다. 런타임에는 영향이 없다.

- **DB**: Supabase PostgreSQL. `DATABASE_URL` 은 커넥션 풀러(포트 6543, `pgbouncer=true`),
  `DIRECT_URL` 은 직접 연결(5432, 마이그레이션용).
- **도메인**: `api.checkmate-v.com` → Route53 CNAME → `*.onrender.com`. TLS 는 Render 가 자동 발급·갱신.
- **슬립 방지**: 무료 인스턴스는 15분 무요청 시 잠들어 콜드스타트가 20초 이상 걸린다.
  외부 모니터(UptimeRobot, 5분 간격)가 `GET /api/health` 를 호출해 깨워둔다.
  이 엔드포인트는 `SELECT 1` 을 태우므로 **핑 하나로 Render 슬립(15분)과 Supabase
  무활동 일시정지(7일)를 함께 막고**, DB 장애 시 500 을 반환해 알림까지 걸린다.

> 📌 이전 구성(AWS EC2 · Nginx · PM2 · GitHub Actions rsync)의 스크립트는 `deploy/`,
> `scripts/deploy.sh`, `scripts/ec2-init.sh` 에 이력으로 남아 있다. 현재는 사용하지 않는다.

---

## 🔗 관련 링크 · Links

- 🟢 **Live**: [checkmate-v.com](https://checkmate-v.com) — 운영 중 · Live
- 🎨 **Frontend**: [404checkmate/Checkmate-Frontend](https://github.com/404checkmate/Checkmate-Frontend)

<div align="center">

**Team 404 · CHECKMATE · 2026**

</div>
