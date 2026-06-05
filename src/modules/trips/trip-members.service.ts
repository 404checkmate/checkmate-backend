import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TripAccessService } from './trip-access.service';
import { NotificationsService } from '../notifications/notifications.service';

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
    private readonly notifications: NotificationsService,
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
    const alreadyMember = isOwner || existing?.status === 'accepted';

    if (!alreadyMember) {
      const now = new Date();
      await this.prisma.$transaction([
        existing
          ? // pending/declined 행이 있으면 수락 처리 (링크 클릭 = 본인 동의)
            this.prisma.tripMember.update({
              where: { id: existing.id },
              data: { status: 'accepted', respondedAt: now },
            })
          : this.prisma.tripMember.create({
              data: { tripId, userId, status: 'accepted', respondedAt: now, invitedBy: invite.createdBy },
            }),
        this.prisma.tripInvite.update({
          where: { id: invite.id },
          data: { usedCount: { increment: 1 } },
        }),
      ]);
      this.logger.log(`trip member joined trip=${tripId} user=${userId}`);
      // 소유자에게 합류 알림 (fire-and-forget)
      void this.notifications.notify({
        userId: invite.trip.userId,
        type: 'trip_member_joined',
        actorId: userId,
        tripId,
        payload: { tripTitle: invite.trip.title },
      });
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

  /**
   * 친구 바로 초대 — 링크 없이 내 친구에게 초대장(pending)을 보낸다.
   * 상대가 수락(respondInvite)해야 멤버가 된다.
   */
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
      throw new BadRequestException('친구만 바로 초대할 수 있어요. 친구가 아니면 초대 링크를 보내 주세요.');
    }

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { userId: true, title: true },
    });
    if (trip?.userId === targetUserId) {
      return { ok: true as const, status: 'already_member' as const, member: serializeMemberUser(target) };
    }

    const existing = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId: targetUserId } },
    });

    if (existing?.status === 'accepted') {
      return { ok: true as const, status: 'already_member' as const, member: serializeMemberUser(target) };
    }
    if (existing?.status === 'pending') {
      return { ok: true as const, status: 'already_invited' as const, member: serializeMemberUser(target) };
    }

    if (existing) {
      // declined → 재초대
      await this.prisma.tripMember.update({
        where: { id: existing.id },
        data: { status: 'pending', invitedBy: requesterId, respondedAt: null },
      });
    } else {
      await this.prisma.tripMember.create({
        data: { tripId, userId: targetUserId, status: 'pending', invitedBy: requesterId },
      });
    }

    this.logger.log(`trip member invited trip=${tripId} target=${targetUserId} by=${requesterId}`);
    // 초대 대상에게 알림 (fire-and-forget)
    void this.notifications.notify({
      userId: targetUserId,
      type: 'trip_invite',
      actorId: requesterId,
      tripId,
      payload: { tripTitle: trip?.title ?? '' },
    });
    return { ok: true as const, status: 'invited' as const, member: serializeMemberUser(target) };
  }

  /** 내가 받은 트립 초대(pending) 목록 — 보관함 상단 배너용 */
  async listReceivedInvites(userId: bigint) {
    const rows = await this.prisma.tripMember.findMany({
      where: { userId, status: 'pending', trip: { deletedAt: null } },
      include: {
        trip: {
          select: {
            id: true,
            title: true,
            tripStart: true,
            tripEnd: true,
            user: { select: MEMBER_PROFILE_SELECT },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    // 초대한 사람(invitedBy) 닉네임 — 소유자가 아닌 멤버가 초대했을 수도 있음
    const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((v): v is bigint => v != null))];
    const inviters = inviterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, nickname: true },
        })
      : [];
    const inviterById = new Map(inviters.map((u) => [u.id.toString(), u.nickname]));

    return rows.map((r) => ({
      tripId: r.trip.id.toString(),
      tripTitle: r.trip.title,
      tripStart: r.trip.tripStart,
      tripEnd: r.trip.tripEnd,
      inviterNickname:
        (r.invitedBy != null ? inviterById.get(r.invitedBy.toString()) : null) ?? r.trip.user.nickname,
      invitedAt: r.joinedAt.toISOString(),
    }));
  }

  /** 받은 초대에 응답 — accept 시 멤버 합류, decline 시 거절 기록 */
  async respondInvite(tripId: bigint, userId: bigint, action: 'accept' | 'decline') {
    const existing = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
      include: { trip: { select: { deletedAt: true, title: true, userId: true } } },
    });
    if (!existing || existing.status !== 'pending' || existing.trip.deletedAt) {
      throw new NotFoundException('대기 중인 초대가 없어요.');
    }

    await this.prisma.tripMember.update({
      where: { id: existing.id },
      data: {
        status: action === 'accept' ? 'accepted' : 'declined',
        respondedAt: new Date(),
      },
    });

    // 수락 시 이동할 대표 보관함
    const latestArchive =
      action === 'accept'
        ? await this.prisma.guideArchive.findFirst({
            where: { checklist: { tripId } },
            orderBy: { archivedAt: 'desc' },
            select: { id: true },
          })
        : null;

    this.logger.log(`trip invite ${action} trip=${tripId} user=${userId}`);

    // 수락 시 초대한 사람(없으면 소유자)에게 알림 (fire-and-forget)
    if (action === 'accept') {
      void this.notifications.notify({
        userId: existing.invitedBy ?? existing.trip.userId,
        type: 'trip_invite_accepted',
        actorId: userId,
        tripId,
        payload: {
          tripTitle: existing.trip.title,
          archiveId: latestArchive?.id.toString() ?? null,
        },
      });
    }

    return {
      ok: true as const,
      action,
      tripId: tripId.toString(),
      archiveId: latestArchive?.id.toString() ?? null,
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
      where: { tripId, status: { in: ['accepted', 'pending'] } }, // declined 은 숨김
      include: { user: { select: MEMBER_PROFILE_SELECT } },
      orderBy: { joinedAt: 'asc' },
    });

    return [
      { ...serializeMemberUser(trip.user), role: 'owner' as const, status: 'accepted' as const, joinedAt: null },
      ...members
        .filter((m) => !m.user.deletedAt)
        .map((m) => ({
          ...serializeMemberUser(m.user),
          role: 'editor' as const,
          status: m.status, // 'accepted' | 'pending'(수락 대기 중)
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
