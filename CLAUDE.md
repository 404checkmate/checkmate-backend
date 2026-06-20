# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Checkmate Backend — AI 여행 체크리스트 서비스 백엔드. NestJS + Prisma + PostgreSQL (Supabase-hosted), with OpenAI for checklist generation.

## Commands

```bash
# Development
npm run start:dev         # Hot-reload dev server
npm run start:prod        # Run compiled dist/main.js

# Build & lint
npm run build             # nest build (TypeScript compile)
npm run lint              # ESLint with auto-fix
npm run format            # Prettier

# Tests
npm test                  # Unit tests (*.spec.ts under src/)
npm run test:watch        # Watch mode
npm run test:cov          # Coverage report
npm run test:e2e          # E2E tests (test/jest-e2e.json config)

# Database
npm run prisma:generate   # Regenerate Prisma client after schema change
npm run prisma:migrate    # Create and apply dev migration (interactive)
npm run prisma:migrate:deploy  # Apply migrations in production
npm run prisma:studio     # Prisma Studio at localhost:5555
npm run prisma:seed       # Seed database

# LLM testing
npm run llm:test          # scripts/test-llm.ts smoke test
```

Local infrastructure (Postgres) via Docker:
```bash
docker-compose up -d
```

## Architecture

### Request Lifecycle

Every incoming request passes through globally-registered providers in `app.module.ts`:
1. **SupabaseJwtGuard** — Validates `Authorization: Bearer <token>`. Tries HS256 → ES256/JWKS → Supabase admin API in order. Skipped on routes decorated with `@Public()`.
2. **ThrottlerGuard** — 60 requests per 60 seconds per IP.
3. **LoggingInterceptor** — Logs method, URL, and duration on every response.
4. **ValidationPipe** (main.ts) — Whitelist + forbidNonWhitelisted + transform + implicit conversion.
5. **HttpExceptionFilter** (main.ts) — All exceptions serialized as `{ success: false, error: { code, message, details }, path, timestamp }`.

### Authentication Flow

- Supabase handles OAuth (Google / Kakao / Naver) and issues JWTs.
- `SupabaseJwtGuard` decodes and verifies the JWT, then populates `request.user` as `AuthUser { supabaseId, userId, email, provider }`.
- **JIT user provisioning**: on the first successful auth for an unknown Supabase ID, `UsersService.findOrCreate()` inserts a new `User` row automatically.
- `@CurrentUser()` decorator injects the `AuthUser` from the request. `@Public()` bypasses the guard entirely.
- Dev bypass: set `AUTH_DEV_BYPASS=true` in `.env` (disallowed in production) to skip JWT verification.

### Module Layout (`src/`)

```
common/         # Guards, interceptors, filters, decorators, JWT utils
config/         # configuration.ts (typed env), validation.ts (Zod schema)
infra/
  prisma/       # Global PrismaModule + PrismaService (singleton client)
  supabase/     # Global SupabaseModule + SupabaseService (admin client)
modules/
  auth/         # Session/verify endpoints
  users/        # Profile, onboarding, consent, passport
  master/       # Read-only reference data (countries, cities, categories, styles)
  trips/        # Trip CRUD + companions, flights, travel styles
  checklists/   # Checklist + item management; split into ChecklistService and ChecklistItemService
  llm/          # OpenAI wrapper (openai.service.ts) — synchronous LLM calls
  guide-archives/ # Archived guide management (uses $transaction for create)
  analytics/    # UserEvent tracking
```

### Database (Prisma + PostgreSQL)

Schema at `prisma/schema.prisma`. Key conventions:
- All IDs are `BigInt @id @default(autoincrement())`. BigInt is serialized to `string` in JSON responses (patched in `main.ts`).
- Column names use `snake_case` mapped from camelCase via `@map`.
- Soft deletes on `User` via `deletedAt`; index on `@@index([deletedAt])`.
- `DIRECT_URL` env var is used for migration commands (bypasses connection pooler).
- Preview feature: `fullTextSearchPostgres`.

Core domain models: `User` → `Trip` → `Checklist` → `ChecklistItem`. Master data (`Country`, `City`, category/style tables) is seeded and read-only at runtime.

### LLM Integration

`LlmModule` wraps OpenAI via `openai.service.ts`. Checklist generation runs **synchronously** during the request that triggers it — `LlmService.requestChecklist` records an `llm_generations` row and `ChecklistsService` calls OpenAI inline. The `LlmStatus` enum (`pending | success | failed`) tracks generation state. Default model: `gpt-4o-mini` (overridable via `LLM_MODEL` env var).

> Async processing via BullMQ + Redis is **planned, not implemented** — see the `TODO(next PR)` in `llm.service.ts`. `@nestjs/bullmq`/`bullmq` are installed as dependencies but no queue, worker, or `BullModule` is wired up yet.

### Environment Variables

Key vars (see `.env.example` for full list):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Prisma connection (pooler-safe) |
| `DIRECT_URL` | Direct Postgres URL for migrations |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_JWT_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` | Auth verification & admin API |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Reserved for planned BullMQ queue (currently unused) |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI config |
| `CORS_ORIGIN` | Comma-separated allowed origins |
| `AUTH_DEV_BYPASS` | Skip JWT in development (forbidden in prod) |

Validated at startup via Zod in `src/config/validation.ts` — misconfigured env causes immediate crash with a clear message.
