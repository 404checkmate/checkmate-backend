import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminMetricsService } from './admin-metrics.service';
import { buildCsvBundle } from './csv.util';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

/** 단일 데이터셋만 뽑았을 때도 의미가 통하도록 내보내기 파일 상단에 붙이는 집계 규칙 설명 */
const EXPORT_NOTES = [
  '집계 규칙: 팀원/지인 이메일 이벤트 제외 · dev 빌드 이벤트(metadata._dev=true) 제외',
  '"저장 시도"는 이벤트 기준(게스트 포함), "실제 저장"은 guide_archives 테이블 기준(로그인 유저만)',
  'content_gap / save_retention 은 기간 필터를 받지 않는 전체 기간 누적값',
  '재방문율(save_retention)은 누적 지표라 조회 시점마다 값이 달라짐',
];

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

  /** 내보내기 가능한 데이터셋 목록 — 프론트 드롭다운/문서화용 */
  @Get('export/datasets')
  exportDatasets() {
    return AdminMetricsService.EXPORT_DATASETS;
  }

  /**
   * 대시보드 지표 파일 내보내기.
   *   GET /admin/metrics/export?from=&to=&format=csv|json&dataset=all|<key>
   * csv(기본)는 데이터셋마다 `## key` 헤더로 구분된 단일 파일, json 은 데이터셋별 배열 객체.
   */
  @Get('export')
  async export(
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format = 'csv',
    @Query('dataset') dataset = 'all',
  ) {
    if (format !== 'csv' && format !== 'json') {
      throw new BadRequestException('format 은 csv 또는 json 이어야 합니다.');
    }
    const known = AdminMetricsService.EXPORT_DATASETS.map((d) => d.key);
    if (dataset !== 'all' && !known.includes(dataset)) {
      throw new BadRequestException(`알 수 없는 dataset 입니다. 사용 가능: all, ${known.join(', ')}`);
    }

    const r = resolveRange(from, to);
    const sections = await this.metrics.exportDatasets(r.from, r.to, dataset);
    const generatedAt = new Date().toISOString();
    const suffix = dataset === 'all' ? '' : `-${dataset.replace(/_/g, '-')}`;
    const filename = `checkmate-metrics${suffix}_${r.from}_${r.to}.${format}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const datasets = Object.fromEntries(sections.map((s) => [s.key, s.rows]));
      const labels = Object.fromEntries(sections.map((s) => [s.key, s.label]));
      res.send(JSON.stringify({ generatedAt, range: r, notes: EXPORT_NOTES, labels, datasets }, null, 2));
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(
      buildCsvBundle(sections, [
        'Checkmate 스크럼 대시보드 지표',
        `기간: ${r.from} ~ ${r.to}`,
        `생성: ${generatedAt}`,
        ...EXPORT_NOTES,
      ]),
    );
  }
}

