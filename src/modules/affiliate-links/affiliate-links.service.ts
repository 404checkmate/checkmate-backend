import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { UpsertAffiliateLinkDto } from './dto/upsert-affiliate-link.dto';

/**
 * 제휴 링크 관리 — 시드 템플릿 항목(checklist_item_templates) 1개당 1개.
 * AI 생성 항목(source=llm)은 템플릿이 없으므로 대상이 아니다.
 */
@Injectable()
export class AffiliateLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** 공개용: 활성 링크 + 템플릿 제목 (프론트가 항목 제목으로 매칭) */
  async publicList() {
    const rows = await this.prisma.affiliateLink.findMany({
      where: { isActive: true },
      include: { template: { select: { title: true } } },
    });
    return rows.map((r) => ({
      templateId: r.templateId.toString(),
      title: r.template.title,
      provider: r.provider,
      url: r.url,
      label: r.label,
    }));
  }

  /** 관리자용: 전체 템플릿 + 현재 링크(없으면 null), 카테고리 순 정렬 */
  async adminListTemplates() {
    const templates = await this.prisma.checklistItemTemplate.findMany({
      include: { affiliateLink: true, category: true },
      orderBy: [{ categoryId: 'asc' }, { id: 'asc' }],
    });
    return templates.map((t) => {
      const c = t.category as Record<string, unknown> | null;
      return {
        templateId: t.id.toString(),
        title: t.title,
        categoryId: t.categoryId.toString(),
        categoryLabel:
          (c?.nameKo as string) ?? (c?.name as string) ?? (c?.label as string) ?? (c?.code as string) ?? null,
        link: t.affiliateLink
          ? {
              provider: t.affiliateLink.provider,
              url: t.affiliateLink.url,
              label: t.affiliateLink.label,
              isActive: t.affiliateLink.isActive,
            }
          : null,
      };
    });
  }

  /** 관리자: 템플릿에 링크 생성/수정 (upsert) */
  async upsert(templateId: string, dto: UpsertAffiliateLinkDto) {
    const id = BigInt(templateId);
    const tpl = await this.prisma.checklistItemTemplate.findUnique({ where: { id } });
    if (!tpl) throw new NotFoundException('템플릿을 찾을 수 없습니다.');
    await this.prisma.affiliateLink.upsert({
      where: { templateId: id },
      create: {
        templateId: id,
        provider: dto.provider,
        url: dto.url,
        label: dto.label ?? null,
        isActive: dto.isActive ?? true,
      },
      update: {
        provider: dto.provider,
        url: dto.url,
        label: dto.label ?? null,
        isActive: dto.isActive ?? true,
      },
    });
    return { ok: true };
  }

  /** 관리자: 링크 제거 */
  async remove(templateId: string) {
    await this.prisma.affiliateLink.deleteMany({ where: { templateId: BigInt(templateId) } });
    return { ok: true };
  }
}
