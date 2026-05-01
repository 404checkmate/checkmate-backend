-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserEventType" ADD VALUE 'page_view';
ALTER TYPE "UserEventType" ADD VALUE 'cta_click';
ALTER TYPE "UserEventType" ADD VALUE 'step_complete';
ALTER TYPE "UserEventType" ADD VALUE 'login';
ALTER TYPE "UserEventType" ADD VALUE 'trip_created';
ALTER TYPE "UserEventType" ADD VALUE 'item_checked';
ALTER TYPE "UserEventType" ADD VALUE 'session_start';
