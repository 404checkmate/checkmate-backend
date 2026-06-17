-- CreateTable
CREATE TABLE "affiliate_links" (
    "id" BIGSERIAL NOT NULL,
    "template_id" BIGINT NOT NULL,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_links_template_id_key" ON "affiliate_links"("template_id");

-- AddForeignKey
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "checklist_item_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
