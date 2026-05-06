import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { UserEventType } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AnalyticsService } from './analytics.service';

interface IngestEventBody {
  userId?: string | number | null;
  tripId?: string | number | null;
  itemId?: string | number | null;
  sessionId: string;
  eventType: UserEventType;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('events')
  @Public()
  @HttpCode(202)
  ingest(@Body() body: IngestEventBody | IngestEventBody[]) {
    const list = Array.isArray(body) ? body : [body];
    return this.analytics.ingestMany(
      list.map((e) => ({
        userId: e.userId !== undefined && e.userId !== null ? BigInt(e.userId) : null,
        tripId: e.tripId !== undefined && e.tripId !== null ? BigInt(e.tripId) : null,
        itemId: e.itemId !== undefined && e.itemId !== null ? BigInt(e.itemId) : null,
        sessionId: e.sessionId,
        eventType: e.eventType,
        metadata: e.metadata,
        occurredAt: e.occurredAt ? new Date(e.occurredAt) : undefined,
      })),
    );
  }
}
