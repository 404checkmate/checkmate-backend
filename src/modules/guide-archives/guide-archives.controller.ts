import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { GuideArchivesService } from './guide-archives.service';

/**
 * Guide Archive (여행별 "저장한 가이드") CRUD.
 *
 * - `Trip → Checklist → GuideArchive` 경로로 이어지는 실제 Prisma 모델 기반 영속화.
 * - JWT Guard 는 전역 적용이므로 이 컨트롤러도 인증된 요청만 통과한다.
 */
@Controller()
export class GuideArchivesController {
  private readonly logger = new Logger(GuideArchivesController.name);

  constructor(private readonly archives: GuideArchivesService) {}

  @Get('trips/:tripId/guide-archives')
  list(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.archives.listByTrip(BigInt(tripId));
  }

  @Post('trips/:tripId/guide-archives')
  @HttpCode(201)
  create(
    @Param('tripId', ParseIntPipe) tripId: number,
    @Body() body: { name?: string; snapshot?: unknown },
  ) {
    return this.archives.createForTrip(BigInt(tripId), body ?? {});
  }

  @Patch('guide-archives/:archiveId')
  update(
    @Param('archiveId', ParseIntPipe) archiveId: number,
    @Body() body: { name?: string; snapshot?: unknown },
  ) {
    return this.archives.update(BigInt(archiveId), body ?? {});
  }

  @Delete('guide-archives/:archiveId')
  @HttpCode(200)
  remove(@Param('archiveId', ParseIntPipe) archiveId: number) {
    return this.archives.remove(BigInt(archiveId));
  }
}
