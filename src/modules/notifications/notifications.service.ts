import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

const LIST_LIMIT = 30;

/**
 * 인앱 알림 (docs/collab-checklist-plan.md Phase 4).
 * 발생 지점(friends / trip-members)에서 notify()를 fire-and-forget 으로 호출하며,
 * 알림 실패가 본 동작(초대/수락)을 막지 않도록 내부에서 모두 삼킨다.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Supabase Realtime Broadcast REST 로 "새 알림" 핑 발행 — 수신자의 벨이 즉시 갱신된다.
   * 웹소켓 연결 없이 HTTP 1회. 실패해도 프론트 60초 폴링이 폴백.
   * 페이로드는 비움(공개 채널이므로 내용 미포함) — 수신 측은 refetch 만 한다.
   */
  private async pushRealtimePing(userId: bigint): Promise<void> {
    try {
      const url = this.config.get<string>('supabase.url');
      const key = this.config.get<string>('supabase.serviceRoleKey');
      if (!url || !key) return;
      await fetch(`${url}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          messages: [{ topic: `cm-user-${userId}`, event: 'notification', payload: {} }],
        }),
      });
    } catch (err) {
      this.logger.warn(`realtime ping 실패 user=${userId}: ${(err as Error)?.message}`);
    }
  }

  /** 알림 생성 — 실패해도 throw 하지 않음 */
  async notify(input: {
    userId: bigint;
    type: NotificationType;
    actorId?: bigint | null;
    tripId?: bigint | null;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    try {
      // 자기 자신에게는 알림 없음
      if (input.actorId != null && input.actorId === input.userId) return;
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          actorId: input.actorId ?? null,
          tripId: input.tripId ?? null,
          payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      void this.pushRealtimePing(input.userId);
    } catch (err) {
      this.logger.warn(`notify 실패 type=${input.type} user=${input.userId}: ${(err as Error)?.message}`);
    }
  }

  /** 최신 알림 목록 + 안읽음 수 */
  async listMine(userId: bigint) {
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        include: {
          actor: { select: { nickname: true, profileImageUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return {
      unreadCount,
      items: items.map((n) => ({
        id: n.id.toString(),
        type: n.type,
        actor: n.actor
          ? { nickname: n.actor.nickname, profileImageUrl: n.actor.profileImageUrl }
          : null,
        tripId: n.tripId?.toString() ?? null,
        payload: n.payload ?? {},
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  /** 읽음 처리 — ids 미지정 시 전체 */
  async markRead(userId: bigint, ids?: bigint[]) {
    const res = await this.prisma.notification.updateMany({
      where: {
        userId,
        readAt: null,
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return { ok: true as const, updated: res.count };
  }
}
