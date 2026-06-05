import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { FriendshipStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const INVITE_TTL_DAYS = 7;
const INVITE_MAX_USES = 10;

const FRIEND_PROFILE_SELECT = {
  id: true,
  nickname: true,
  profileImageUrl: true,
  deletedAt: true,
} as const;

function serializeFriend(u: {
  id: bigint;
  nickname: string;
  profileImageUrl: string | null;
}) {
  return {
    userId: u.id.toString(),
    nickname: u.nickname,
    profileImageUrl: u.profileImageUrl,
  };
}

/**
 * 친구 기능 (docs/collab-checklist-plan.md Phase 1).
 * 추가 방식은 초대 링크 우선 — 토큰 수락 시 바로 accepted 친구가 된다.
 */
@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 내 친구 초대 링크 생성 (7일 / 10회) */
  async createInvite(userId: bigint) {
    const token = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    const invite = await this.prisma.friendInvite.create({
      data: { token, creatorId: userId, expiresAt, maxUses: INVITE_MAX_USES },
    });
    this.logger.log(`friend invite created user=${userId} token=${token.slice(0, 6)}…`);
    return {
      token: invite.token,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses,
    };
  }

  /** 초대 미리보기 — 비로그인 랜딩에서 "OO님의 초대" 표시용 (@Public) */
  async previewInvite(token: string) {
    const invite = await this.prisma.friendInvite.findUnique({
      where: { token },
      include: { creator: { select: FRIEND_PROFILE_SELECT } },
    });
    if (!invite || invite.creator.deletedAt) {
      throw new NotFoundException('유효하지 않은 초대 링크예요.');
    }
    const valid =
      invite.expiresAt > new Date() && invite.usedCount < invite.maxUses;
    return {
      creator: serializeFriend(invite.creator),
      valid,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** 초대 수락 — 양방향 중복을 한 행으로 관리, 멱등 */
  async acceptInvite(token: string, userId: bigint) {
    const invite = await this.prisma.friendInvite.findUnique({
      where: { token },
    });
    if (!invite) throw new NotFoundException('유효하지 않은 초대 링크예요.');
    if (invite.creatorId === userId) {
      throw new BadRequestException('자신의 초대 링크는 수락할 수 없어요.');
    }
    if (invite.expiresAt <= new Date() || invite.usedCount >= invite.maxUses) {
      throw new BadRequestException('만료된 초대 링크예요. 새 링크를 요청해 주세요.');
    }

    const creator = await this.prisma.user.findFirst({
      where: { id: invite.creatorId, deletedAt: null },
      select: FRIEND_PROFILE_SELECT,
    });
    if (!creator) throw new NotFoundException('초대한 사용자를 찾을 수 없어요.');

    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: invite.creatorId, addresseeId: userId },
          { requesterId: userId, addresseeId: invite.creatorId },
        ],
      },
    });

    if (existing?.status === FriendshipStatus.accepted) {
      return { ok: true as const, alreadyFriends: true, friend: serializeFriend(creator) };
    }

    const now = new Date();
    await this.prisma.$transaction([
      existing
        ? this.prisma.friendship.update({
            where: { id: existing.id },
            data: { status: FriendshipStatus.accepted, respondedAt: now },
          })
        : this.prisma.friendship.create({
            data: {
              requesterId: invite.creatorId,
              addresseeId: userId,
              status: FriendshipStatus.accepted,
              respondedAt: now,
            },
          }),
      this.prisma.friendInvite.update({
        where: { id: invite.id },
        data: { usedCount: { increment: 1 } },
      }),
    ]);

    this.logger.log(`friend accepted creator=${invite.creatorId} user=${userId}`);
    // 링크 생성자에게 "친구가 됐어요" 알림 (fire-and-forget)
    void this.notifications.notify({
      userId: invite.creatorId,
      type: 'friend_accepted',
      actorId: userId,
    });
    return { ok: true as const, alreadyFriends: false, friend: serializeFriend(creator) };
  }

  /** 수락된 친구 목록 */
  async listFriends(userId: bigint) {
    const rows = await this.prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.accepted,
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: FRIEND_PROFILE_SELECT },
        addressee: { select: FRIEND_PROFILE_SELECT },
      },
      orderBy: { respondedAt: 'desc' },
    });

    return rows
      .map((r) => {
        const other = r.requesterId === userId ? r.addressee : r.requester;
        if (other.deletedAt) return null;
        return {
          ...serializeFriend(other),
          since: (r.respondedAt ?? r.createdAt).toISOString(),
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
  }

  /** 친구 삭제 (양방향) */
  async removeFriend(userId: bigint, friendUserId: bigint) {
    const res = await this.prisma.friendship.deleteMany({
      where: {
        status: FriendshipStatus.accepted,
        OR: [
          { requesterId: userId, addresseeId: friendUserId },
          { requesterId: friendUserId, addresseeId: userId },
        ],
      },
    });
    if (res.count === 0) throw new NotFoundException('친구 관계가 없습니다.');
    this.logger.log(`friend removed user=${userId} friend=${friendUserId}`);
    return { ok: true as const };
  }
}
