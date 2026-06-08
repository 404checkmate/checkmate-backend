import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BaggageType,
  ChecklistGeneratedBy,
  ChecklistItemSource,
  PrepType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TripAccessService } from '../trips/trip-access.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly tripAccess: TripAccessService,
  ) {}

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
          // 내 소유 트립 + 내가 멤버로 합류(수락 완료)한 트립 (공동 편집)
          trip: {
            deletedAt: null,
            OR: [{ userId }, { members: { some: { userId, status: 'accepted' } } }],
          },
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
            // 요청자 기준 준비율 계산용 — personal 은 내 체크 행, shared 는 공유 isChecked
            items: {
              where: { isSelected: true, deletedAt: null },
              select: {
                scope: true,
                isChecked: true,
                personalChecks: { where: { userId, isChecked: true }, select: { id: true } },
              },
            },
            trip: {
              select: {
                id: true,
                title: true,
                tripStart: true,
                tripEnd: true,
                userId: true,
                user: { select: { nickname: true, profileImageUrl: true } },
                members: {
                  where: { status: 'accepted' }, // 수락 대기 중인 초대는 공유 표시에서 제외
                  select: {
                    userId: true,
                    user: { select: { nickname: true, profileImageUrl: true, deletedAt: true } },
                  },
                  orderBy: { joinedAt: 'asc' },
                },
              },
            },
          },
        },
      },
      orderBy: { archivedAt: 'desc' },
    });

    return archives.map((a) => {
      const trip = a.checklist.trip;
      const members = trip.members.filter((m) => !m.user.deletedAt);
      const isShared = members.length > 0;
      const isOwner = trip.userId === userId;
      // 내 기준 준비율 — 개인 짐은 내 체크, 공동 짐은 공유 체크. 항목이 없으면 저장된 팀 지표로 폴백.
      const items = a.checklist.items;
      const myCheckedCount = items.filter((it) =>
        it.scope === 'shared' ? it.isChecked : it.personalChecks.length > 0,
      ).length;
      const myCompletionRate =
        items.length === 0
          ? Number(a.checklist.completionRate)
          : (myCheckedCount / items.length) * 100;
      // 나를 제외한 참여자(소유자 포함) 미리보기 — 카드 아바타 스택용
      const othersPool = [
        { userId: trip.userId, nickname: trip.user.nickname, profileImageUrl: trip.user.profileImageUrl },
        ...members.map((m) => ({
          userId: m.userId,
          nickname: m.user.nickname,
          profileImageUrl: m.user.profileImageUrl,
        })),
      ].filter((p) => p.userId !== userId);

      return {
        id: a.id.toString(),
        name: a.name,
        archivedAt: a.archivedAt.toISOString(),
        isAiRecommended: a.isAiRecommended,
        snapshot: a.snapshot,
        checklistStatus: a.checklist.status,
        // 보는 사람 기준 준비율 — 필드명은 기존 프론트 호환을 위해 유지
        completionRate: myCompletionRate,
        trip: {
          id: trip.id.toString(),
          title: trip.title,
          tripStart: trip.tripStart,
          tripEnd: trip.tripEnd,
        },
        // 공동 편집 메타 — 공유 중이 아니면 null
        shared: isShared
          ? {
              isOwner,
              memberCount: members.length + 1, // 소유자 포함
              ownerNickname: trip.user.nickname,
              others: othersPool.slice(0, 3).map(({ nickname, profileImageUrl }) => ({
                nickname,
                profileImageUrl,
              })),
            }
          : null,
      };
    });
  }

  async createForTrip(tripId: bigint, userId: bigint, input: { name?: string; snapshot?: unknown; isAiRecommended?: boolean }) {
    // 멤버도 생성 가능 (공동 편집) — 권한 중앙 검사
    await this.tripAccess.assertTripAccess(tripId, userId);

    const name = (input.name ?? '보관함 항목').toString().slice(0, 120);
    const rawSnapshot =
      input.snapshot &&
      typeof input.snapshot === 'object' &&
      !Array.isArray(input.snapshot)
        ? (input.snapshot as Record<string, unknown>)
        : {};

    const archive = await this.prisma.$transaction(
      async (tx) => {
        const checklist = await tx.checklist.upsert({
          where: { tripId },
          create: {
            tripId,
            generatedBy: ChecklistGeneratedBy.template,
            status: 'not_started',
          },
          update: {},
          select: { id: true },
        });

        // 큐레이션 등 serverId 없는 snapshot 항목을 실제 ChecklistItem 행으로 만들어
        // serverId 를 주입한다 — 협업(scope/담당자/멤버별 체크)이 이 행에 붙기 때문.
        const snapshot = await this.persistSnapshotItems(
          tx,
          checklist.id,
          rawSnapshot,
        );

        return tx.guideArchive.create({
          data: {
            checklistId: checklist.id,
            name,
            snapshot: snapshot as Prisma.InputJsonValue,
            isAiRecommended: input.isAiRecommended ?? false,
          },
        });
      },
      { timeout: 15000 },
    );

    this.logger.log(`archive created trip=${tripId} id=${archive.id}`);
    return this.serialize(archive);
  }

  /**
   * snapshot.items 중 serverId 가 없는 항목(큐레이션 등)을 실제 ChecklistItem 행으로 만들고
   * 그 id 를 serverId 로 주입해 돌려준다. 이미 serverId 가 있는 항목(AI/검색)은 그대로 둔다.
   * → 협업 UI(개인/공동·담당자·멤버별 체크)가 붙을 서버 항목이 생긴다.
   */
  private async persistSnapshotItems(
    tx: Prisma.TransactionClient,
    checklistId: bigint,
    snapshot: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const items = Array.isArray(snapshot.items)
      ? (snapshot.items as Record<string, unknown>[])
      : null;
    if (!items || items.length === 0) return snapshot;

    const needsRow = (it: Record<string, unknown>) =>
      it && (it.serverId == null || String(it.serverId).trim() === '');
    const targets: Array<{ it: Record<string, unknown>; idx: number }> = [];
    items.forEach((it, idx) => {
      if (needsRow(it)) targets.push({ it, idx });
    });
    if (targets.length === 0) return snapshot;

    const categories = await tx.checklistCategory.findMany();
    if (categories.length === 0) return snapshot; // 카테고리 시드 없으면 협업만 생략
    const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));
    const fallbackCategoryId =
      categories.find((c) => c.code === 'ai_recommend')?.id ?? categories[0].id;

    const PREP = new Set<string>(Object.values(PrepType));
    const BAG = new Set<string>(Object.values(BaggageType));
    const startOrder = await tx.checklistItem.count({ where: { checklistId } });

    const created = await Promise.all(
      targets.map(({ it }, i) => {
        const prepType = PREP.has(String(it.prepType))
          ? (it.prepType as PrepType)
          : PrepType.item;
        const baggageType = BAG.has(String(it.baggageType))
          ? (it.baggageType as BaggageType)
          : BaggageType.none;
        const categoryId =
          (typeof it.categoryCode === 'string'
            ? categoryIdByCode.get(it.categoryCode)
            : undefined) ?? fallbackCategoryId;
        return tx.checklistItem.create({
          data: {
            checklistId,
            categoryId,
            title: String(it.title ?? '').slice(0, 200) || '항목',
            description: it.description != null ? String(it.description) : null,
            prepType,
            baggageType,
            source: ChecklistItemSource.user_added,
            orderIndex: startOrder + i,
            isSelected: true,
            selectedAt: new Date(),
          },
          select: { id: true },
        });
      }),
    );

    const nextItems = [...items];
    targets.forEach(({ idx }, i) => {
      nextItems[idx] = { ...nextItems[idx], serverId: created[i].id.toString() };
    });
    return { ...snapshot, items: nextItems };
  }

  async findOne(archiveId: bigint, userId: bigint) {
    const archive = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
      include: {
        checklist: {
          include: { trip: { select: { id: true, userId: true, title: true } } },
        },
      },
    });

    if (!archive) throw new NotFoundException('아카이브를 찾을 수 없습니다.');
    await this.tripAccess.assertTripAccess(archive.checklist.trip.id, userId, 'view');

    return this.serialize(archive);
  }

  async update(archiveId: bigint, userId: bigint, patch: { name?: string; snapshot?: unknown }) {
    const existing = await this.prisma.guideArchive.findUnique({
      where: { id: archiveId },
      include: {
        checklist: {
          include: { trip: { select: { id: true, userId: true } } },
        },
      },
    });
    if (!existing) throw new NotFoundException('아카이브를 찾을 수 없습니다.');
    await this.tripAccess.assertTripAccess(existing.checklist.trip.id, userId);

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
          include: { trip: { select: { id: true, userId: true } } },
        },
      },
    });
    if (!existing) throw new NotFoundException('아카이브를 찾을 수 없습니다.');
    // 보관함 엔트리 삭제는 소유자 전용 (멤버 실수 방지)
    await this.tripAccess.assertTripAccess(existing.checklist.trip.id, userId, 'owner');

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
