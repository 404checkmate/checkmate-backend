-- AlterEnum
-- AuthProvider enum 에서 미사용 값 'naver' 제거 (실제 인증은 google/kakao 만 구현).
-- 운영 DB 확인 결과 provider='naver' 행은 0건이므로 USING 캐스팅 안전.
BEGIN;
CREATE TYPE "AuthProvider_new" AS ENUM ('google', 'kakao');
ALTER TABLE "user_auth_providers" ALTER COLUMN "provider" TYPE "AuthProvider_new" USING ("provider"::text::"AuthProvider_new");
ALTER TYPE "AuthProvider" RENAME TO "AuthProvider_old";
ALTER TYPE "AuthProvider_new" RENAME TO "AuthProvider";
DROP TYPE "AuthProvider_old";
COMMIT;
