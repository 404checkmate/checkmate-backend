import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AffiliateLinksService } from './affiliate-links.service';
import { UpsertAffiliateLinkDto } from './dto/upsert-affiliate-link.dto';

/** 공개 — 프론트가 항목 제목으로 제휴 링크를 매칭하기 위해 활성 링크 목록 조회 */
@Controller('affiliate-links')
export class AffiliateLinksController {
  constructor(private readonly service: AffiliateLinksService) {}

  @Public()
  @Get()
  list() {
    return this.service.publicList();
  }
}

/** 관리자 전용 — 템플릿별 제휴 링크 관리 (ADMIN_EMAILS 가드) */
@Controller('admin/affiliate-links')
@UseGuards(AdminGuard)
export class AdminAffiliateLinksController {
  constructor(private readonly service: AffiliateLinksService) {}

  @Get('templates')
  templates() {
    return this.service.adminListTemplates();
  }

  @Put(':templateId')
  upsert(@Param('templateId') templateId: string, @Body() dto: UpsertAffiliateLinkDto) {
    return this.service.upsert(templateId, dto);
  }

  @Delete(':templateId')
  remove(@Param('templateId') templateId: string) {
    return this.service.remove(templateId);
  }
}
