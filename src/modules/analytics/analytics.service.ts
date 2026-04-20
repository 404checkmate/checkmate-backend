import { Injectable } from '@nestjs/common';
import { Prisma, UserEventType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface IngestEventInput {
  userId: bigint;
  tripId?: bigint | null;
  itemId?: bigint | null;
  sessionId: string;
  eventType: UserEventType;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * 사용자 행동 이벤트 수집.
 * 배치 삽입 가능하도록 배열 버전을 함께 제공한다.
 * 프론트 `utils/*Storage.js`에서 수집된 이벤트를 이 엔드포인트로 전송하도록 연동 예정.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  ingestOne(input: IngestEventInput) {
    return this.prisma.userEvent.create({
      data: {
        userId: input.userId,
        tripId: input.tripId ?? null,
        itemId: input.itemId ?? null,
        sessionId: input.sessionId,
        eventType: input.eventType,
        metadata:
          input.metadata === undefined || input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  }

  ingestMany(events: IngestEventInput[]) {
    if (events.length === 0) return { count: 0 };
    return this.prisma.userEvent.createMany({
      data: events.map((e) => ({
        userId: e.userId,
        tripId: e.tripId ?? null,
        itemId: e.itemId ?? null,
        sessionId: e.sessionId,
        eventType: e.eventType,
        metadata:
          e.metadata === undefined || e.metadata === null
            ? Prisma.JsonNull
            : (e.metadata as Prisma.InputJsonValue),
        occurredAt: e.occurredAt ?? new Date(),
      })),
    });
  }
}
