-- CreateEnum
-- 트립 멤버 상태. "친구 바로 추가"를 일방 합류에서 초대(pending) → 수락(accepted) 흐름으로 전환.
-- 초대 링크 합류는 본인이 직접 수락하는 행위이므로 즉시 accepted 로 생성.
CREATE TYPE "TripMemberStatus" AS ENUM ('pending', 'accepted', 'declined');

-- AlterTable
-- 기존 멤버 행은 DEFAULT 로 전부 accepted 백필 (이미 합류한 멤버 권한 유지)
ALTER TABLE "trip_members" ADD COLUMN "status" "TripMemberStatus" NOT NULL DEFAULT 'accepted';
ALTER TABLE "trip_members" ADD COLUMN "responded_at" TIMESTAMP(3);

-- CreateIndex
-- 받은 초대 목록 조회용 (user_id, status)
CREATE INDEX "trip_members_user_id_status_idx" ON "trip_members"("user_id", "status");
