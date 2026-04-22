-- AlterTable
-- Candidate pool 모델: 생성된 항목은 기본적으로 "후보(is_selected=false)" 상태로 저장된다.
-- 레거시 데이터(이 마이그레이션 적용 이전에 존재하던 아이템) 는 전부 사용자가 이미 채택한 것으로 간주하기 위해
-- 우선 NOT NULL + DEFAULT true 로 컬럼을 추가하고, 이후 스키마 정의(기본 false) 와 일치하도록 DEFAULT 만 변경한다.
ALTER TABLE "checklist_items"
  ADD COLUMN "is_selected" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "checklist_items"
  ADD COLUMN "selected_at" TIMESTAMP(3);

-- 레거시 행: selected_at 을 created_at 으로 채워 "언제부터 담겨있었나" 가 어색하지 않도록 한다.
UPDATE "checklist_items"
SET "selected_at" = "created_at"
WHERE "is_selected" = true AND "selected_at" IS NULL;

-- 신규 행은 기본적으로 후보 상태(false) 로 들어오도록 DEFAULT 재설정.
ALTER TABLE "checklist_items"
  ALTER COLUMN "is_selected" SET DEFAULT false;

-- CreateIndex
-- 사용자 "내 체크리스트" 조회 (is_selected=true) 와 "후보 풀" 조회 모두를 빠르게 한다.
CREATE INDEX "checklist_items_checklist_id_is_selected_idx"
  ON "checklist_items"("checklist_id", "is_selected");
