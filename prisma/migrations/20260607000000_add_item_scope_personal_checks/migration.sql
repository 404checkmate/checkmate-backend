-- CreateEnum
CREATE TYPE "ItemScope" AS ENUM ('personal', 'shared');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'item_assigned';

-- AlterTable
ALTER TABLE "checklist_items" ADD COLUMN     "assignee_user_id" BIGINT,
ADD COLUMN     "scope" "ItemScope" NOT NULL DEFAULT 'personal';

-- CreateTable
CREATE TABLE "checklist_item_personal_checks" (
    "id" BIGSERIAL NOT NULL,
    "item_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "is_checked" BOOLEAN NOT NULL DEFAULT false,
    "checked_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_item_personal_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checklist_item_personal_checks_user_id_idx" ON "checklist_item_personal_checks"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_item_personal_checks_item_id_user_id_key" ON "checklist_item_personal_checks"("item_id", "user_id");

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_item_personal_checks" ADD CONSTRAINT "checklist_item_personal_checks_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "checklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_item_personal_checks" ADD CONSTRAINT "checklist_item_personal_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: 기존 항목은 전부 personal 로 남으므로, 이미 체크된(is_checked=true) 항목의
-- 체크 상태를 오너 + accepted 멤버 전원의 개인 체크 행으로 복사해 아무도 상태를 잃지 않게 한다.
INSERT INTO "checklist_item_personal_checks" ("item_id", "user_id", "is_checked", "checked_at", "updated_at")
SELECT ci.id, m.user_id, true, COALESCE(ci.checked_at, now()), now()
FROM "checklist_items" ci
JOIN "checklists" c ON c.id = ci.checklist_id
JOIN "trips" t ON t.id = c.trip_id
JOIN LATERAL (
  SELECT t.user_id
  UNION
  SELECT tm.user_id FROM "trip_members" tm WHERE tm.trip_id = t.id AND tm.status = 'accepted'
) m ON true
WHERE ci.is_checked = true AND ci.deleted_at IS NULL
ON CONFLICT ("item_id", "user_id") DO NOTHING;
