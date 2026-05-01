import {
  BadRequestException,
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
  UnauthorizedException,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateGuideArchiveDto } from './dto/create-guide-archive.dto';
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

  @Get('guide-archives/mine')
  mine(@CurrentUser() user: AuthUser | undefined) {
    const userId = this.requireUserId(user);
    return this.archives.listMine(userId);
  }

  @Get('guide-archives/:archiveId')
  findOne(
    @CurrentUser() user: AuthUser | undefined,
    @Param('archiveId', ParseIntPipe) archiveId: number,
  ) {
    const userId = this.requireUserId(user);
    return this.archives.findOne(BigInt(archiveId), userId);
  }

  @Get('trips/:tripId/guide-archives')
  list(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.archives.listByTrip(BigInt(tripId));
  }

  @Post('trips/:tripId/guide-archives')
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
    @Body() body: CreateGuideArchiveDto,
  ) {
    const userId = this.requireUserId(user);
    return this.archives.createForTrip(BigInt(tripId), userId, body ?? {});
  }

  @Patch('guide-archives/:archiveId')
  update(
    @CurrentUser() user: AuthUser | undefined,
    @Param('archiveId', ParseIntPipe) archiveId: number,
    @Body() body: { name?: string; snapshot?: unknown },
  ) {
    const userId = this.requireUserId(user);
    return this.archives.update(BigInt(archiveId), userId, body ?? {});
  }

  @Delete('guide-archives/:archiveId')
  @HttpCode(200)
  remove(
    @CurrentUser() user: AuthUser | undefined,
    @Param('archiveId', ParseIntPipe) archiveId: number,
  ) {
    const userId = this.requireUserId(user);
    return this.archives.remove(BigInt(archiveId), userId);
  }

  private requireUserId(user: AuthUser | undefined): bigint {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException('JIT 프로비저닝이 아직 안 된 세션입니다.');
    }
    return user.userId;
  }
}
