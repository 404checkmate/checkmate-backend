-- AlterTable
-- users 테이블에 약관/온보딩 관련 컬럼 3개를 추가한다.
--
--   legal_consent_accepted_at : POST /api/users/me/consent 호출 시점 (nullable)
--   marketing_opt_in          : 마케팅 정보 수신 동의 여부 (NOT NULL, 기본 false)
--   onboarding_completed_at   : 최초로 성별 + 생년월일이 모두 기록된 시점 (nullable)
--
-- 세 컬럼 모두 nullable 또는 DEFAULT 가 있으므로 기존 레거시 유저 행은 그대로 유지된다.
-- 이미 gender != 'unknown' AND birth_date IS NOT NULL 인 유저에 대해서만
-- onboarding_completed_at 을 created_at 으로 소급 스탬프해서 "이미 온보딩 된 것"으로 취급한다.
ALTER TABLE "users"
  ADD COLUMN "legal_consent_accepted_at" TIMESTAMP(3),
  ADD COLUMN "marketing_opt_in"          BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN "onboarding_completed_at"   TIMESTAMP(3);

-- 레거시 사용자 소급 처리: 이미 프로필이 채워진 유저는 onboardingCompletedAt 를 created_at 으로 간주.
UPDATE "users"
SET "onboarding_completed_at" = "created_at"
WHERE "gender" <> 'unknown'
  AND "birth_date" IS NOT NULL
  AND "onboarding_completed_at" IS NULL;
