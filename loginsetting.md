# 소셜 로그인 키 발급 & 설정 가이드

> 대상: Checkmate 프로젝트 (`checkmate-backend` + `Checkmate-Frontend`)
> 범위: **Supabase / Google / Kakao** 3개 사이트에서 발급받아야 하는 키와, 각 키를 **백엔드 `.env` · 프론트 `.env.local` · 각 플랫폼 대시보드** 중 어디에 넣을지를 한 번에 정리. (Naver 로그인은 지원하지 않음)
> 최종 업데이트: 2026-04-21

---

## 0. 전체 그림 (한눈에)

| 플랫폼 | 발급받는 항목 | 백엔드 `.env` | 프론트 `.env.local` | 그 외 (어디에 등록) |
| --- | --- | --- | --- | --- |
| **Supabase** | Project URL | `SUPABASE_URL` | `VITE_SUPABASE_URL` | — |
| Supabase | anon key | `SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` | — |
| Supabase | JWT secret | `SUPABASE_JWT_SECRET` | (❌ 프론트에 넣지 말 것) | — |
| Supabase | service_role key | `SUPABASE_SERVICE_ROLE_KEY` | (❌ 프론트에 넣지 말 것) | — |
| **Google Cloud** | OAuth Client ID / Secret | — | — | **Supabase 대시보드 > Auth > Providers > Google** |
| **Kakao Developers** | REST API 키 / Client Secret | — | — | **Supabase 대시보드 > Auth > Providers > Kakao** |

**핵심 원칙 2가지**
1. **Google/Kakao 키는 백엔드/프론트 `.env` 가 아니라 Supabase 대시보드에 직접 붙여 넣는다.** (Supabase Auth 가 관리)
2. **`SUPABASE_JWT_SECRET` 과 `SUPABASE_SERVICE_ROLE_KEY` 는 절대 프론트에 넣지 않는다.** (브라우저 번들에 노출되면 사고)

---

## 1. Supabase 프로젝트 생성 & 키 확보

### 1-1. 프로젝트 만들기
1. <https://supabase.com/dashboard> 접속 → GitHub 로 로그인
2. 상단 `New project` 클릭
3. 입력
   - **Name**: `checkmate` (아무거나)
   - **Database Password**: 강한 비번 생성 후 안전한 곳에 보관 (나중에 `DATABASE_URL` 비번)
   - **Region**: `Northeast Asia (Seoul)` 또는 `Tokyo` 권장
   - **Pricing Plan**: Free
4. `Create new project` → 2~3분 대기

### 1-2. 키 4종 복사

Supabase 대시보드 사이드바:

| 대시보드 위치 | 복사할 값 | 이름 |
| --- | --- | --- |
| **Project Settings > Data API** | `Project URL` | **SUPABASE_URL** |
| **Project Settings > API Keys** | `anon` `public` 키 | **SUPABASE_ANON_KEY** |
| **Project Settings > API Keys** | `service_role` `secret` 키 | **SUPABASE_SERVICE_ROLE_KEY** |
| **Project Settings > JWT Keys** (하단 `Legacy JWT Secret`) | JWT Secret | **SUPABASE_JWT_SECRET** |

> `service_role` 과 `JWT Secret` 은 **`Reveal` 버튼** 을 눌러야 보입니다. 한 번 노출되면 주변 사람 눈치 봐서 바로 가려 두세요.

### 1-3. `.env` 에 기입

**백엔드 `checkmate-backend/.env`**
```env
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...                 # 1-2 의 anon 키
SUPABASE_JWT_SECRET=super-long-jwt-secret...    # 1-2 의 JWT Secret
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...         # 1-2 의 service_role 키
```

**프론트 `Checkmate-Frontend/.env.local`** (없으면 새로 만든다. `.env.local` 은 gitignore 됨)
```env
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
VITE_API_BASE_URL=http://localhost:8080/api
```

### 1-4. (권장) Supabase 의 Postgres DB 를 그대로 사용하려면

`Project Settings > Database > Connection string` 에서 **Connection pooler (Transaction mode, port 6543)** 의 URI 와 **Direct connection (port 5432)** URI 를 복사.

**백엔드 `.env`**
```env
DATABASE_URL=postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

> 지금은 로컬 Docker Postgres 를 쓰고 있으므로 이 설정은 **배포 시점에 바꿔도 됩니다.** 로컬 개발 중엔 기존 `postgresql://checkmate:checkmate@localhost:5432/...` 유지해도 무방.

---

## 2. Google OAuth (Google Cloud Console → Supabase 에 붙이기)

Google 키는 **백엔드/프론트 `.env` 에 안 들어갑니다.** Supabase 대시보드에만 등록합니다.

### 2-1. Google Cloud 프로젝트 + 동의 화면
1. <https://console.cloud.google.com/> 접속 → 상단 프로젝트 드롭다운 → `New Project` → 이름 `checkmate` → 만들기
2. 상단 검색창 **`OAuth consent screen`** → 이동
3. `External` 선택 → `Create`
4. 필수 입력
   - **App name**: `Checkmate`
   - **User support email**: 본인 이메일
   - **Developer contact**: 본인 이메일
5. `Save and Continue` 로 4단계 통과 (Scopes/Users 는 비워도 됨)
6. **Publishing status** 를 `In production` 으로 바꿀 때까지는 "테스트 중" 이라 등록한 테스트 계정만 로그인 가능 → 본인 구글 계정을 `Audience > Test users` 에 추가

### 2-2. OAuth Client ID 발급
1. 좌측 메뉴 **`APIs & Services > Credentials`**
2. 상단 `+ CREATE CREDENTIALS` → **`OAuth client ID`**
3. **Application type**: `Web application`
4. **Name**: `Checkmate (Supabase)`
5. **Authorized JavaScript origins** — 추가:
   - `https://<your-supabase-project-ref>.supabase.co`
   - `http://localhost:5173` (Vite 개발 서버)
6. **Authorized redirect URIs** — 추가 (⚠️ Supabase 가 주는 값을 그대로):
   - `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback`
   - (필요 시 개발용) `http://localhost:5173/auth/callback`
   > Supabase 대시보드 **Auth > Providers > Google** 페이지 상단에 복사 버튼으로 redirect URL 이 제공됩니다. 그 값을 그대로 붙여 넣는 게 가장 안전.
7. `Create` → 팝업에 나온 **Client ID** / **Client Secret** 을 복사

### 2-3. Supabase 에 등록
1. Supabase 대시보드 → **Authentication > Providers**
2. `Google` 토글 ON
3. **Client ID (for OAuth)**, **Client Secret (for OAuth)** 붙여 넣기
4. `Save`

> 발급받은 Client ID/Secret 은 **어디에도 저장 안 해도 됩니다** (Supabase 가 보관). 분실하면 Google Cloud 에서 재발급.

---

## 3. Kakao Login (Kakao Developers → Supabase 에 붙이기)

Kakao 키도 **`.env` 에 안 들어가고** Supabase 대시보드에만 등록합니다.

### 3-1. 애플리케이션 등록
1. <https://developers.kakao.com/> 로그인 → 상단 **`내 애플리케이션`**
2. `+ 애플리케이션 추가하기`
   - **앱 이름**: `Checkmate`
   - **회사명**: 팀명 또는 개인명
   - 저장
3. 생성된 앱 클릭 → 좌측 **`앱 키`** — 메모할 값:
   - **REST API 키** (이걸 Supabase 의 `Client ID` 로 사용)

### 3-2. Client Secret 발급 (권장, Supabase 필수는 아님)
1. 좌측 **`제품 설정 > 카카오 로그인 > 보안`**
2. **Client Secret** 영역 → `코드 생성` → 상태 `사용함` 으로 변경
3. 생성된 `Client Secret 코드` 복사

### 3-3. 카카오 로그인 활성화 & 리다이렉트 URI 등록
1. **`제품 설정 > 카카오 로그인 > 일반`**
2. **카카오 로그인** 활성화 토글 ON
3. **Redirect URI** 등록 (Supabase 가 알려 주는 값):
   - `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback`
4. **동의항목** (`제품 설정 > 카카오 로그인 > 동의항목`)
   - **닉네임** (`profile_nickname`) — 필수 동의
   - **프로필 사진** (`profile_image`) — 선택 동의
   - **카카오계정(이메일)** (`account_email`) — 선택/필수. (⚠️ 비즈 앱 심사 없이는 `선택 동의` 까지만 가능. 이 경우 우리 백엔드는 이메일 없어도 합성 이메일로 JIT 프로비저닝하도록 이미 처리되어 있음 — 걱정 안 해도 됨.)

### 3-4. 플랫폼 등록
1. 좌측 **`앱 설정 > 플랫폼`**
2. **Web 플랫폼 등록** → 사이트 도메인 추가
   - `http://localhost:5173`
   - (배포 후) 실제 도메인

### 3-5. Supabase 에 등록
1. Supabase 대시보드 → **Authentication > Providers > Kakao** 토글 ON
2. **Kakao Client ID** = 카카오 **REST API 키**
3. **Kakao Client Secret** = 3-2 에서 받은 코드 (없이 진행 가능하지만 권장)
4. `Save`

---

## 5. 환경변수 최종 체크리스트

### 5-1. `checkmate-backend/.env` (전체 합친 예시)

```env
# App
NODE_ENV=development
PORT=8080
API_PREFIX=api
CORS_ORIGIN=http://localhost:5173

# Database — 로컬 Docker 쓰는 경우 (지금 진행 중)
DATABASE_URL=postgresql://checkmate:checkmate@localhost:5432/checkmate?schema=public
DIRECT_URL=postgresql://checkmate:checkmate@localhost:5432/checkmate?schema=public
# → Supabase Postgres 로 바꿀 때:
# DATABASE_URL=postgresql://postgres.<ref>:<db-pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
# DIRECT_URL=postgresql://postgres.<ref>:<db-pw>@aws-0-<region>.pooler.supabase.com:5432/postgres

# Supabase — §1
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_JWT_SECRET=super-long-jwt-secret...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# Social Login — Google/Kakao 는 Supabase Auth 가 처리. 백엔드가 따로 중개하지 않음.
FRONTEND_AUTH_CALLBACK_URL=http://localhost:5173/auth/callback
AUTH_DEV_BYPASS=true                  # 개발 편의(키 안 채웠어도 dev-anon 통과). 운영 전환 전 false 로.

# Redis / LLM — 기존과 동일 (변경 없음)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
LLM_PROVIDER=openai
LLM_API_KEY=
LLM_MODEL=gpt-4o-mini
```

### 5-2. `Checkmate-Frontend/.env.local` (전체 합친 예시)

```env
# 앱
VITE_APP_NAME=Checkmate
VITE_APP_ENV=development

# 백엔드
VITE_API_BASE_URL=http://localhost:8080/api

# Supabase (Google/Kakao 용) — §1
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...

# 분석 등 기타 (비워 둬도 OK)
VITE_ANALYTICS_KEY=
```

> `.env.local` 은 **gitignore** 대상입니다. 커밋 금지. 팀원에게 공유할 땐 슬랙/1Password/비트워든 등으로.

### 5-3. 넣으면 안 되는 것 (보안)

| 값 | 위치 | 이유 |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | 프론트 ❌ | 이 키는 RLS 를 우회하는 어드민 권한. 브라우저 번들에 들어가면 모든 사용자 데이터 조작 가능 |
| `SUPABASE_JWT_SECRET` | 프론트 ❌ | JWT 위조 가능해짐 |
| `LLM_API_KEY` | 프론트 ❌ | 비용 폭탄 |

---

## 6. 각 플랫폼 Redirect URL 요약표

배포 URL 이 바뀔 때마다 이 표만 다시 업데이트하면 됩니다.

| 플랫폼 | 등록 위치 | 개발용 URL | 운영용 URL (예시) |
| --- | --- | --- | --- |
| Google Cloud Console | OAuth Client → Authorized redirect URIs | `https://<ref>.supabase.co/auth/v1/callback` | 동일 (Supabase 가 중계하므로 변경 없음) |
| Kakao Developers | 카카오 로그인 → Redirect URI | `https://<ref>.supabase.co/auth/v1/callback` | 동일 |
| Supabase | Authentication > URL Configuration | **Site URL** `http://localhost:5173`<br>**Redirect URLs** `http://localhost:5173/auth/callback` | 실 도메인 |

> Supabase 의 **Site URL** / **Redirect URLs** 설정은 반드시 채워야 합니다. Auth > URL Configuration 에서 `http://localhost:5173` 와 `http://localhost:5173/auth/callback` 을 허용 목록에 등록해 주세요. 안 하면 Google/Kakao 로그인 후 리다이렉트가 막힙니다.

---

## 7. 로컬 검증 체크리스트

아래 순서대로 통과하면 소셜 로그인 2종(Google/Kakao) 모두 살아있는 상태입니다.

1. **백엔드 기동**
   ```bash
   cd checkmate-backend
   docker compose up -d        # Postgres + Redis
   npx prisma migrate deploy
   npm run start:dev
   ```
2. **프론트 기동**
   ```bash
   cd Checkmate-Frontend
   npm run dev                 # http://localhost:5173
   ```
3. **Dev-bypass 확인**: 브라우저에서 `http://localhost:8080/api/auth/me` → `{"user":{"supabaseId":"dev-anon", ...}}` 가 나오면 env 로딩 OK.
4. **Supabase 실검증 전환**: `.env` 에 `SUPABASE_JWT_SECRET` 값이 채워지면 Guard 가 자동으로 실검증 모드. `/auth/me` 는 Bearer 토큰 없으면 401 반환.
5. **Google 로그인**: `http://localhost:5173/login` → `Google로 시작하기` → 구글 계정 선택 → `/auth/callback` → consent → onboarding. 브라우저 devtools Application 탭에서 `localStorage.checkmate:auth_token` 확인.
6. **Kakao 로그인**: 위와 동일 플로우.
7. **백엔드 DB 확인**:
   ```bash
   npx prisma studio           # http://localhost:5555
   ```
   `users` 테이블에 새 행, `user_auth_providers` 테이블에 `(provider, provider_user_id)` 링크 row 확인.

---

## 8. 자주 만나는 에러 & 해결

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| Google 로그인 후 `redirect_uri_mismatch` | Google Cloud Console 의 Authorized redirect URIs 에 Supabase callback 이 없음 | §2-2 의 redirect URI 그대로 재등록 |
| Kakao 로그인 후 `KOE101` | 카카오 Redirect URI 미등록 or 활성화 안 됨 | §3-3 재확인 |
| 프론트 `/auth/callback` 이 `no_session` 으로 끝남 | Supabase 가 URL 을 파싱하기 전에 React 라우터가 먼저 리다이렉트 | `src/lib/supabase.js` 의 `detectSessionInUrl: true` 유지 + AuthCallbackPage 의 `ranRef` 유지. 새로고침 한 번으로도 복구됨 |
| 백엔드 `/auth/me` 가 계속 `dev-anon` | `SUPABASE_JWT_SECRET` 미설정 or `AUTH_DEV_BYPASS=true` | 운영 전환 전 `AUTH_DEV_BYPASS=false` + JWT secret 채우기 |

---

## 9. 배포 전 전환 체크리스트 (나중에 다시 볼 목록)

- [ ] `AUTH_DEV_BYPASS=false` 로 변경
- [ ] `NODE_ENV=production` 설정
- [ ] `CORS_ORIGIN` 에 실제 프론트 도메인만 포함
- [ ] Google Cloud OAuth 동의 화면을 `Testing → In production` 으로 전환 (검수 필요)
- [ ] Kakao 앱을 **사업자 정보 등록** (Kakao 정책 상 이메일 필수 동의 받으려면 필요)
- [ ] Supabase 의 Site URL / Redirect URLs 에 운영 도메인 추가
- [ ] 프론트 `.env.production` 에 운영용 Supabase / API URL 세팅
- [ ] 모든 secret 값은 배포 플랫폼(Railway/Render/Fly 등)의 Environment Variables 에 등록 (소스 리포지토리 절대 금지)
