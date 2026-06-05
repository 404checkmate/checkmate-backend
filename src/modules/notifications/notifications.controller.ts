import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional } from 'class-validator';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

class MarkReadDto {
  @IsOptional()
  @IsArray()
  @IsNumberString({}, { each: true })
  ids?: string[];
}

/**
 * 인앱 알림 API
 *
 *   GET  /api/notifications        최신 30개 + unreadCount
 *   POST /api/notifications/read   읽음 처리 (ids 생략 시 전체)
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  private requireUserId(user: AuthUser | undefined): bigint {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException('JIT 프로비저닝이 아직 안 된 세션입니다.');
    }
    return user.userId;
  }

  @Get()
  listMine(@CurrentUser() user: AuthUser | undefined) {
    const userId = this.requireUserId(user);
    return this.notifications.listMine(userId);
  }

  @Post('read')
  @HttpCode(200)
  markRead(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: MarkReadDto,
  ) {
    const userId = this.requireUserId(user);
    return this.notifications.markRead(userId, dto.ids?.map((id) => BigInt(id)));
  }
}
