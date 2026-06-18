import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminMetricsService } from './admin-metrics.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

/** from/to 쿼리 파라미터 검증 + 기본값(최근 30일) 적용 */
function resolveRange(from?: string, to?: string): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const f = from ?? defaultFrom;
  const t = to ?? today;
  if (!DATE_RE.test(f) || !DATE_RE.test(t)) {
    throw new BadRequestException('from/to 는 YYYY-MM-DD 형식이어야 합니다.');
  }
  if (f > t) throw new BadRequestException('from 이 to 보다 늦을 수 없습니다.');
  return { from: f, to: t };
}

@Controller('admin/metrics')
@UseGuards(AdminGuard)
export class AdminMetricsController {
  constructor(private readonly metrics: AdminMetricsService) {}

  @Get('funnel')
  funnel(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.funnel(r.from, r.to);
  }

  @Get('logins')
  logins(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.logins(r.from, r.to);
  }

  @Get('channels')
  channels(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.channels(r.from, r.to);
  }

  @Get('content-gap')
  contentGap() {
    return this.metrics.contentGap();
  }

  @Get('retention')
  retention(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.retention(r.from, r.to);
  }

  @Get('save-retention')
  saveRetention() {
    return this.metrics.saveRetention();
  }

  @Get('guest-preview')
  guestPreview(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.guestPreview(r.from, r.to);
  }

  @Get('travel-test')
  travelTest(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.travelTest(r.from, r.to);
  }

  @Get('travel-test-types')
  travelTestTypes(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.travelTestTypes(r.from, r.to);
  }

  @Get('collab')
  collab(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.collab(r.from, r.to);
  }

  @Get('ad-targeting')
  adTargeting(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.adTargeting(r.from, r.to);
  }

  @Get('affiliate-clicks')
  affiliateClicks(@Query('from') from?: string, @Query('to') to?: string) {
    const r = resolveRange(from, to);
    return this.metrics.affiliateClicks(r.from, r.to);
  }
}
