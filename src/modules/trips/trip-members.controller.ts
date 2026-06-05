import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsIn, IsNumberString } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { TripMembersService } from './trip-members.service';

class AddTripMemberDto {
  @IsNumberString()
  userId!: string;
}

class RespondTripInviteDto {
  @IsIn(['accept', 'decline'])
  action!: 'accept' | 'decline';
}

/**
 * 트립 멤버/초대 API — 체크리스트 공동 편집 (docs/collab-checklist-plan.md Phase 2)
 *
 *   POST   /api/trips/:tripId/invites          초대 링크 생성 (소유자/멤버)
 *   GET    /api/trips/invites/:token           초대 미리보기 (비로그인 허용)
 *   POST   /api/trips/invites/:token/accept    초대 수락 → 멤버 합류
 *   GET    /api/trips/:tripId/members          멤버 목록 (소유자 포함)
 *   DELETE /api/trips/:tripId/members/:userId  내보내기(소유자) / 나가기(본인)
 */
@Controller('trips')
export class TripMembersController {
  constructor(private readonly tripMembers: TripMembersService) {}

  private requireUserId(user: AuthUser | undefined): bigint {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException('JIT 프로비저닝이 아직 안 된 세션입니다.');
    }
    return user.userId;
  }

  @Post(':tripId/invites')
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  createInvite(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
  ) {
    const userId = this.requireUserId(user);
    return this.tripMembers.createInvite(BigInt(tripId), userId);
  }

  @Public()
  @Get('invites/:token')
  previewInvite(@Param('token') token: string) {
    return this.tripMembers.previewInvite(token);
  }

  /** 내가 받은 트립 초대(수락 대기) 목록 — 보관함 상단 배너용
   *  주의: 정적 세그먼트라 `:tripId/members` 보다 먼저 선언해야 함 */
  @Get('member-invites/received')
  listReceivedInvites(@CurrentUser() user: AuthUser | undefined) {
    const userId = this.requireUserId(user);
    return this.tripMembers.listReceivedInvites(userId);
  }

  /** 받은 초대 응답 — Body: { action: 'accept' | 'decline' } */
  @Patch(':tripId/members/me')
  @HttpCode(200)
  respondInvite(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
    @Body() dto: RespondTripInviteDto,
  ) {
    const userId = this.requireUserId(user);
    return this.tripMembers.respondInvite(BigInt(tripId), userId, dto.action);
  }

  @Post('invites/:token/accept')
  @HttpCode(200)
  acceptInvite(
    @CurrentUser() user: AuthUser | undefined,
    @Param('token') token: string,
  ) {
    const userId = this.requireUserId(user);
    return this.tripMembers.acceptInvite(token, userId);
  }

  /** 친구 바로 추가 — Body: { userId } (수락된 친구만 허용) */
  @Post(':tripId/members')
  @HttpCode(200)
  addMember(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
    @Body() dto: AddTripMemberDto,
  ) {
    const userId = this.requireUserId(user);
    return this.tripMembers.addFriendAsMember(BigInt(tripId), userId, BigInt(dto.userId));
  }

  @Get(':tripId/members')
  listMembers(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
  ) {
    const userId = this.requireUserId(user);
    return this.tripMembers.listMembers(BigInt(tripId), userId);
  }

  @Delete(':tripId/members/:userId')
  @HttpCode(200)
  removeMember(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
    @Param('userId', ParseIntPipe) targetUserId: number,
  ) {
    const userId = this.requireUserId(user);
    return this.tripMembers.removeMember(BigInt(tripId), BigInt(targetUserId), userId);
  }
}
