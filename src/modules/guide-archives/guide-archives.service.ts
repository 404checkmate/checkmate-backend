import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

  async listMine(userId: bigint) {
    const archives = await this.prisma.guideArchive.findMany({
      where: {
        checklist: {
          trip: { userId, deletedAt: null },
        },
      },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        isAiRecommended: true,
        snapshot: true,
        checklist: {
          select: {
            status: true,
            completionRate: true,
            trip: {
              select: {
                id: true,
                title: true,
                tripStart: true,
                tripEnd: true,
              },
            },
          },
        },
      },
      orderBy: { archivedAt: 'desc' },
    });

    return archives.map((a) => ({
      id: a.id.toString(),
      name: a.name,
      archivedAt: a.archivedAt.toISOString(),
      isAiRecommended: a.isAiRecommended,
      snapshot: a.snapshot,
      checklistStatus: a.checklist.status,
      completionRate: Number(a.checklist.completionRate),
      trip: {
        id: a.checklist.trip.id.toString(),
        title: a.checklist.trip.title,
        tripStart: a.checklist.trip.tripStart,
        tripEnd: a.checklist.trip.tripEnd,
      },
    }));
  }

  async createForTrip(tripId: bigint, userId: bigint, input: { name?: string; snapshot?: unknown; isAiRecommended?: boolean }) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    if (trip.userId !== userId) {
      throw new ForbiddenException('이 여행에 대한 권한이 없습니다.');
    }

    // upsert 로 원자적 생성 — 동시 요청 시 unique constraint 충돌 방지.
    const checklist = await this.prisma.checklist.upsert({
      where: { tripId },
      create: {
        tripId,
        generatedBy: ChecklistGeneratedBy.template,
        status: 'not_started',
      },
      update: {},
      select: { id: true },
    });

    const name = (input.name ?? '보관함 항목').toString().slice(0, 120);
    const snapshot = (input.snapshot ?? {}) as Prisma.InputJsonValue;

    const archive = await this.prisma.guideArchive.create({
      data: {
        checklistId: checklist.id,
        name,
        snapshot,
        isAiRecommended: input.isAiRecommended ?? false,
      },
    });

    this.logger.log(`archive created trip=${tripId} id=${archive.id}`);
    return this.serialize(archive);
  }

  async findOne(archiveId: bigint, userId: bigint) {
    const archive = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
      include: {
        checklist: {
          include: { trip: { select: { userId: true, title: true } } },
        },
      },
    });

    if (!archive) throw new NotFoundException('아카이브를 찾을 수 없습니다.');
    if (archive.checklist.trip.userId !== userId) {
      throw new ForbiddenException('접근 권한이 없습니다.');
    }

    return this.serialize(archive);
  }

  async update(archiveId: bigint, userId: bigint, patch: { name?: string; snapshot?: unknown }) {
    const existing = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
      include: {
        checklist: {
          include: { trip: { select: { userId: true } } },
        },
      },
    });
    if (!existing) throw new NotFoundException('아카이브를 찾을 수 없습니다.');
    if (existing.checklist.trip.userId !== userId) {
      throw new ForbiddenException('수정 권한이 없습니다.');
    }

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

  async remove(archiveId: bigint, userId: bigint) {
    const existing = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
      include: {
        checklist: {
          include: { trip: { select: { userId: true } } },
        },
      },
    });
    if (!existing) throw new NotFoundException('아카이브를 찾을 수 없습니다.');
    if (existing.checklist.trip.userId !== userId) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }

    await this.prisma.guideArchive.delete({ where: { id: archiveId } });
    this.logger.log(`archive deleted id=${archiveId}`);

    return {
      ok: true as const,
      id: archiveId.toString(),
      message: '아카이브가 삭제되었습니다.',
    };
  }

  private serialize(a: {
    id: bigint;
    checklistId: bigint;
    name: string;
    snapshot: Prisma.JsonValue;
    archivedAt: Date;
    isAiRecommended: boolean;
  }) {
    return {
      id: a.id.toString(),
      checklistId: a.checklistId.toString(),
      name: a.name,
      snapshot: a.snapshot,
      archivedAt: a.archivedAt.toISOString(),
      // 클라이언트 호환 필드 — 스텁 버전에서 `updatedAt` 도 돌려줬기 때문에 유지.
      updatedAt: a.archivedAt.toISOString(),
      isAiRecommended: a.isAiRecommended,
    };
  }
}
