import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChecklistGeneratedBy, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Guide Archive = 한 여행(Trip)에 대해 사용자가 저장한 체크리스트 스냅샷.
 * 스키마 상 `GuideArchive` 는 `Checklist` 에 1:N 으로 붙고, Checklist 는 Trip 과 1:1 이다.
 *
 * 프론트는 tripId 로 접근하므로 Service 는 항상 `trip -> checklist` 를 해소한 뒤
 * 그 아래의 GuideArchive 를 CRUD 한다. Checklist 가 아직 없으면 이 flow 가 시작될 때
 * "아카이브 생성 시점에 자동으로" 만든다 (generatedBy=template).
 */
@Injectable()
export class GuideArchivesService {
  private readonly logger = new Logger(GuideArchivesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listByTrip(tripId: bigint) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      select: { id: true },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);

    const archives = await this.prisma.guideArchive.findMany({
      where: { checklist: { tripId } },
      orderBy: { archivedAt: 'desc' },
    });

    return {
      tripId: tripId.toString(),
      archives: archives.map((a) => this.serialize(a)),
    };
  }

  async createForTrip(tripId: bigint, input: { name?: string; snapshot?: unknown }) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      select: { id: true },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);

    // Checklist 가 없으면 lazy 생성 (아카이브만 먼저 저장하는 케이스 방어).
    let checklist = await this.prisma.checklist.findUnique({
      where: { tripId },
      select: { id: true },
    });
    if (!checklist) {
      checklist = await this.prisma.checklist.create({
        data: {
          tripId,
          generatedBy: ChecklistGeneratedBy.template,
          status: 'not_started',
        },
        select: { id: true },
      });
    }

    const name = (input.name ?? '보관함 항목').toString().slice(0, 120);
    const snapshot = (input.snapshot ?? {}) as Prisma.InputJsonValue;

    const archive = await this.prisma.guideArchive.create({
      data: {
        checklistId: checklist.id,
        name,
        snapshot,
      },
    });

    this.logger.log(`archive created trip=${tripId} id=${archive.id}`);
    return this.serialize(archive);
  }

  async update(archiveId: bigint, patch: { name?: string; snapshot?: unknown }) {
    const existing = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
    });
    if (!existing) throw new NotFoundException(`archive ${archiveId} not found`);

    const data: Prisma.GuideArchiveUpdateInput = {};
    if (typeof patch.name === 'string') {
      data.name = patch.name.slice(0, 120);
    }
    if (patch.snapshot !== undefined) {
      data.snapshot = patch.snapshot as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.guideArchive.update({
      where: { id: archiveId },
      data,
    });

    this.logger.log(`archive updated id=${archiveId}`);
    return this.serialize(updated);
  }

  async remove(archiveId: bigint) {
    const existing = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
    });
    if (!existing) throw new NotFoundException(`archive ${archiveId} not found`);

    await this.prisma.guideArchive.delete({ where: { id: archiveId } });
    this.logger.log(`archive deleted id=${archiveId}`);

    return { ok: true as const, id: archiveId.toString() };
  }

  private serialize(a: {
    id: bigint;
    checklistId: bigint;
    name: string;
    snapshot: Prisma.JsonValue;
    archivedAt: Date;
  }) {
    return {
      id: a.id.toString(),
      checklistId: a.checklistId.toString(),
      name: a.name,
      snapshot: a.snapshot,
      archivedAt: a.archivedAt.toISOString(),
      // 클라이언트 호환 필드 — 스텁 버전에서 `updatedAt` 도 돌려줬기 때문에 유지.
      updatedAt: a.archivedAt.toISOString(),
    };
  }
}
