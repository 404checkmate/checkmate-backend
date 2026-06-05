import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { FriendsService } from './friends.service';

/**
 * 친구 API — 초대 링크 방식 (docs/collab-checklist-plan.md Phase 1)
 *
 *   POST   /api/friends/invites               내 초대 링크 생성
 *   GET    /api/friends/invites/:token        초대 미리보기 (비로그인 허용)
 *   POST   /api/friends/invites/:token/accept 초대 수락 → 친구 맺기
 *   GET    /api/friends                       친구 목록
 *   DELETE /api/friends/:friendUserId         친구 삭제
 */
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  private requireUserId(user: AuthUser | undefined): bigint {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException('JIT 프로비저닝이 아직 안 된 세션입니다.');
    }
    return user.userId;
  }

  @Post('invites')
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  createInvite(@CurrentUser() user: AuthUser | undefined) {
    const userId = this.requireUserId(user);
    return this.friends.createInvite(userId);
  }

  @Public()
  @Get('invites/:token')
  previewInvite(@Param('token') token: string) {
    return this.friends.previewInvite(token);
  }

  @Post('invites/:token/accept')
  @HttpCode(200)
  acceptInvite(
    @CurrentUser() user: AuthUser | undefined,
    @Param('token') token: string,
  ) {
    const userId = this.requireUserId(user);
    return this.friends.acceptInvite(token, userId);
  }

  @Get()
  listFriends(@CurrentUser() user: AuthUser | undefined) {
    const userId = this.requireUserId(user);
    return this.friends.listFriends(userId);
  }

  @Delete(':friendUserId')
  @HttpCode(200)
  removeFriend(
    @CurrentUser() user: AuthUser | undefined,
    @Param('friendUserId', ParseIntPipe) friendUserId: number,
  ) {
    const userId = this.requireUserId(user);
    return this.friends.removeFriend(userId, BigInt(friendUserId));
  }
}
