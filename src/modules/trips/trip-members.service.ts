import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TripAccessService } from './trip-access.service';

const INVITE_TTL_DAYS = 7;
const INVITE_MAX_USES = 10;

const MEMBER_PROFILE_SELECT = {
  id: true,
  nickname: true,
  profileImageUrl: true,
  deletedAt: true,
} as const;

function serializeMemberUser(u: {
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
 * 트립 멤버(체크리스트 공동 편집) — docs/collab-checklist-plan.md Phase 2.
 * 합류는 초대 링크 토큰 방식. 소유자는 Trip.userId, 멤버는 trip_members 행.
 */
@Injectable()
export class TripMembersService {
  private readonly logger = new Logger(TripMembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tripAccess: TripAccessService,
  ) {}

  /** 초대 링크 생성 — 소유자/멤버 모두 가능 (함께 더 부르기) */
  async createInvite(tripId: bigint, userId: bigint) {
    await this.tripAccess.assertTripAccess(tripId, userId);
    const token = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    const invite = await this.prisma.tripInvite.create({
      data: { tripId, token, createdBy: userId, expiresAt, maxUses: INVITE_MAX_USES },
    });
    this.logger.log(`trip invite created trip=${tripId} by=${userId}`);
    return {
      token: invite.token,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses,
    };
  }

  /** 초대 미리보기 — 비로그인 랜딩용 (@Public) */
  async previewInvite(token: string) {
    const invite = await this.prisma.tripInvite.findUnique({
      where: { token },
      include: {
        trip: {
          select: {
            id: true,
            title: true,
            tripStart: true,
            tripEnd: true,
            deletedAt: true,
            user: { select: MEMBER_PROFILE_SELECT },
            _count: { select: { members: true } },
          },
        },
      },
    });
    if (!invite || invite.trip.deletedAt || invite.trip.user.deletedAt) {
      throw new NotFoundException('유효하지 않은 초대 링크예요.');
    }
    const valid =
      invite.expiresAt > new Date() && invite.usedCount < invite.maxUses;
    return {
      trip: {
        id: invite.trip.id.toString(),
        title: invite.trip.title,
        tripStart: invite.trip.tripStart,
        tripEnd: invite.trip.tripEnd,
        memberCount: invite.trip._count.members + 1, // 소유자 포함
      },
      inviter: serializeMemberUser(invite.trip.user),
      valid,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** 초대 수락 — 멤버 합류 (멱등). 합류 후 이동할 대표 보관함 id도 함께 반환 */
  async acceptInvite(token: string, userId: bigint) {
    const invite = await this.prisma.tripInvite.findUnique({
      where: { token },
      include: { trip: { select: { id: true, userId: true, title: true, deletedAt: true } } },
    });
    if (!invite || invite.trip.deletedAt) {
      throw new NotFoundException('유효하지 않은 초대 링크예요.');
    }
    if (invite.expiresAt <= new Date() || invite.usedCount >= invite.maxUses) {
      throw new BadRequestException('만료된 초대 링크예요. 새 링크를 요청해 주세요.');
    }

    const tripId = invite.trip.id;
    const isOwner = invite.trip.userId === userId;
    const existing = isOwner
      ? null
      : await this.prisma.tripMember.findUnique({
          where: { tripId_userId: { tripId, userId } },
        });
    const alreadyMember = isOwner || existing != null;

    if (!alreadyMember) {
      await this.prisma.$transaction([
        this.prisma.tripMember.create({
          data: { tripId, userId, invitedBy: invite.createdBy },
        }),
        this.prisma.tripInvite.update({
          where: { id: invite.id },
          data: { usedCount: { increment: 1 } },
        }),
      ]);
      this.logger.log(`trip member joined trip=${tripId} user=${userId}`);
    }

    // 합류 후 이동할 대표 보관함 (최신 엔트리)
    const latestArchive = await this.prisma.guideArchive.findFirst({
      where: { checklist: { tripId } },
      orderBy: { archivedAt: 'desc' },
      select: { id: true },
    });

    return {
      ok: true as const,
      alreadyMember,
      tripId: tripId.toString(),
      tripTitle: invite.trip.title,
      archiveId: latestArchive?.id.toString() ?? null,
    };
  }

  /** 친구 바로 추가 — 링크 없이 내 친구를 멤버로 초대 (친구 관계 필수) */
  async addFriendAsMember(tripId: bigint, requesterId: bigint, targetUserId: bigint) {
    await this.tripAccess.assertTripAccess(tripId, requesterId);

    if (targetUserId === requesterId) {
      throw new BadRequestException('자기 자신은 추가할 수 없어요.');
    }

    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: MEMBER_PROFILE_SELECT,
    });
    if (!target) throw new NotFoundException('사용자를 찾을 수 없어요.');

    // 임의 userId 추가 방지 — 수락된 친구 관계만 허용
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: requesterId },
        ],
      },
      select: { id: true },
    });
    if (!friendship) {
      throw new BadRequestException('친구만 바로 추가할 수 있어요. 친구가 아니면 초대 링크를 보내 주세요.');
    }

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { userId: true },
    });
    const alreadyMember =
      trip?.userId === targetUserId ||
      (await this.prisma.tripMember.findUnique({
        where: { tripId_userId: { tripId, userId: targetUserId } },
        select: { id: true },
      })) != null;

    if (!alreadyMember) {
      await this.prisma.tripMember.create({
        data: { tripId, userId: targetUserId, invitedBy: requesterId },
      });
      this.logger.log(`trip member added directly trip=${tripId} target=${targetUserId} by=${requesterId}`);
    }

    return {
      ok: true as const,
      alreadyMember,
      member: serializeMemberUser(target),
    };
  }

  /** 멤버 목록 — 소유자 + trip_members (요청자도 멤버여야 조회 가능) */
  async listMembers(tripId: bigint, userId: bigint) {
    await this.tripAccess.assertTripAccess(tripId, userId, 'view');

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { userId: true, user: { select: MEMBER_PROFILE_SELECT } },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);

    const members = await this.prisma.tripMember.findMany({
      where: { tripId },
      include: { user: { select: MEMBER_PROFILE_SELECT } },
      orderBy: { joinedAt: 'asc' },
    });

    return [
      { ...serializeMemberUser(trip.user), role: 'owner' as const, joinedAt: null },
      ...members
        .filter((m) => !m.user.deletedAt)
        .map((m) => ({
          ...serializeMemberUser(m.user),
          role: 'editor' as const,
          joinedAt: m.joinedAt.toISOString(),
        })),
    ];
  }

  /** 멤버 제거 — 소유자가 내보내기 또는 본인이 나가기 */
  async removeMember(tripId: bigint, targetUserId: bigint, requesterId: bigint) {
    if (targetUserId === requesterId) {
      // 본인 나가기 — 멤버 여부만 확인
      const res = await this.prisma.tripMember.deleteMany({
        where: { tripId, userId: targetUserId },
      });
      if (res.count === 0) throw new NotFoundException('이 여행의 멤버가 아니에요.');
      this.logger.log(`trip member left trip=${tripId} user=${targetUserId}`);
      return { ok: true as const, left: true };
    }

    // 타인 제거는 소유자 전용
    await this.tripAccess.assertTripAccess(tripId, requesterId, 'owner');
    const res = await this.prisma.tripMember.deleteMany({
      where: { tripId, userId: targetUserId },
    });
    if (res.count === 0) throw new NotFoundException('해당 멤버를 찾을 수 없어요.');
    this.logger.log(`trip member removed trip=${tripId} target=${targetUserId} by=${requesterId}`);
    return { ok: true as const, left: false };
  }
}
