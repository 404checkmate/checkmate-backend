-- CreateEnum
-- 트립 멤버 역할. 소유자는 trips.user_id 로 표현하며(owner 행 미생성),
-- enum 의 owner 값과 viewer 등은 향후 확장 대비.
CREATE TYPE "TripMemberRole" AS ENUM ('owner', 'editor');

-- CreateTable
-- 체크리스트 공동 편집 멤버 (docs/collab-checklist-plan.md Phase 2)
CREATE TABLE "trip_members" (
    "id" BIGSERIAL NOT NULL,
    "trip_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role" "TripMemberRole" NOT NULL DEFAULT 'editor',
    "invited_by" BIGINT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- 트립 합류 초대 링크 토큰 (기본 7일 / 10회 제한)
CREATE TABLE "trip_invites" (
    "id" BIGSERIAL NOT NULL,
    "trip_id" BIGINT NOT NULL,
    "token" TEXT NOT NULL,
    "created_by" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 10,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_members_trip_id_user_id_key" ON "trip_members"("trip_id", "user_id");

-- CreateIndex
CREATE INDEX "trip_members_user_id_idx" ON "trip_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_invites_token_key" ON "trip_invites"("token");

-- CreateIndex
CREATE INDEX "trip_invites_trip_id_idx" ON "trip_invites"("trip_id");

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invites" ADD CONSTRAINT "trip_invites_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
