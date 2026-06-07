import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BaggageType,
  CheckAction,
  ChecklistGeneratedBy,
  ChecklistItemSource,
  ChecklistStatus,
  EditType,
  ItemScope,
  NotificationType,
  Prisma,
  PrepType,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TripAccessService } from '../trips/trip-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  OpenaiService,
  ReclassifyInputItem,
  ReclassifiedItem,
} from '../llm/openai.service';
import type { GeneratedChecklistItem } from './checklists.service';
import type { UpsertItemDto, EditItemDto } from './dto/upsert-items.dto';

type PersistedChecklistItem = Prisma.ChecklistItemGetPayload<{
  include: { category: true };
}>;

@Injectable()
export class ChecklistItemService {
  private readonly logger = new Logger(ChecklistItemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenaiService,
    private readonly tripAccess: TripAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  // =========================================================
  // SELECT / DESELECT (candidate pool → my checklist)
  // =========================================================

  async selectItem(itemId: bigint, userId: bigint): Promise<PersistedChecklistItem> {
    await this.tripAccess.assertItemAccess(itemId, userId);
    return this.prisma.checklistItem.update({
      where: { id: itemId },
      data: { isSelected: true, selectedAt: new Date() },
      include: { category: true },
    });
  }

  async deselectItem(itemId: bigint, userId: bigint): Promise<PersistedChecklistItem> {
    await this.tripAccess.assertItemAccess(itemId, userId);
    return this.prisma.checklistItem.update({
      where: { id: itemId },
      data: { isSelected: false, selectedAt: null },
      include: { category: true },
    });
  }

  // =========================================================
  // UPSERT / EDIT / DELETE / CHECK (영속화 + 로그)
  // =========================================================

  async upsertItems(tripId: bigint, userId: bigint, items: UpsertItemDto[]) {
    await this.tripAccess.assertTripAccess(tripId, userId);

    const categories = await this.prisma.checklistCategory.findMany();
    const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));
    const fallbackCategory =
      categories.find((c) => c.code === 'ai_recommend') ?? categories[0];

    const { createdIds, updatedIds } = await this.prisma.$transaction(async (tx) => {
      const checklist = await tx.checklist.upsert({
        where: { tripId },
        create: {
          tripId,
          generatedBy: ChecklistGeneratedBy.template,
          status: 'not_started',
        },
        update: {},
      });

      const existing = await tx.checklistItem.findMany({
        where: { checklistId: checklist.id, deletedAt: null },
      });
      const existingByKey = new Map(
        existing.map((e) => [this.normalizeTitle(e.title), e]),
      );

      type ExistingItem = (typeof existing)[number];

      const toCreate: Array<{ input: UpsertItemDto; categoryId: bigint }> = [];
      const toUpdate: Array<{
        input: UpsertItemDto;
        match: ExistingItem;
        before: object;
        after: object;
      }> = [];

      const mapSource = (s: UpsertItemDto['source']): ChecklistItemSource => {
        if (s === 'template') return ChecklistItemSource.template;
        if (s === 'llm') return ChecklistItemSource.llm;
        return ChecklistItemSource.user_added;
      };

      for (const input of items) {
        const key = this.normalizeTitle(input.title);
        const match = existingByKey.get(key);
        const categoryId =
          categoryIdByCode.get(input.categoryCode) ?? fallbackCategory?.id;
        if (!categoryId) {
          throw new Error('[upsertItems] seed 된 ChecklistCategory 가 없습니다.');
        }

        if (match) {
          const changed =
            match.description !== (input.description ?? null) ||
            match.prepType !== (input.prepType as PrepType) ||
            match.baggageType !== (input.baggageType as BaggageType) ||
            match.orderIndex !== input.orderIndex ||
            !match.isSelected;

          if (!changed) continue;

          toUpdate.push({
            input,
            match,
            before: {
              title: match.title,
              description: match.description,
              prepType: match.prepType,
              baggageType: match.baggageType,
              orderIndex: match.orderIndex,
            },
            after: {
              title: input.title,
              description: input.description ?? null,
              prepType: input.prepType,
              baggageType: input.baggageType,
              orderIndex: input.orderIndex,
            },
          });
        } else {
          toCreate.push({ input, categoryId });
        }
      }

      const createdItems = await Promise.all(
        toCreate.map(({ input, categoryId }) =>
          tx.checklistItem.create({
            data: {
              checklistId: checklist!.id,
              categoryId,
              title: input.title,
              description: input.description ?? null,
              prepType: input.prepType as PrepType,
              baggageType: input.baggageType as BaggageType,
              source: mapSource(input.source),
              orderIndex: input.orderIndex,
              isSelected: true,
              selectedAt: new Date(),
            },
          }),
        ),
      );

      await Promise.all(
        toUpdate.map(({ input, match }) =>
          tx.checklistItem.update({
            where: { id: match.id },
            data: {
              description: input.description ?? null,
              prepType: input.prepType as PrepType,
              baggageType: input.baggageType as BaggageType,
              orderIndex: input.orderIndex,
              isSelected: true,
              selectedAt: new Date(),
            },
          }),
        ),
      );

      const editLogData: Prisma.ChecklistItemEditCreateManyInput[] = [
        ...createdItems.map((item) => ({
          itemId: item.id,
          userId,
          editType: EditType.add,
          afterValue: {
            title: item.title,
            source: item.source,
            orderIndex: item.orderIndex,
          } as Prisma.InputJsonValue,
        })),
        ...toUpdate.map(({ match, input, before, after }) => ({
          itemId: match.id,
          userId,
          editType:
            match.orderIndex !== input.orderIndex ? EditType.reorder : EditType.text,
          beforeValue: before as Prisma.InputJsonValue,
          afterValue: after as Prisma.InputJsonValue,
        })),
      ];

      if (editLogData.length > 0) {
        await tx.checklistItemEdit.createMany({ data: editLogData });
      }

      return {
        createdIds: createdItems.map((i) => i.id),
        updatedIds: toUpdate.map(({ match }) => match.id),
      };
    }, { timeout: 30000, maxWait: 10000 });

    this.logger.log(
      `[upsertItems] trip=${tripId} user=${userId} created=${createdIds.length} updated=${updatedIds.length}`,
    );

    const allItems = await this.prisma.checklistItem.findMany({
      where: { checklist: { tripId }, deletedAt: null },
      orderBy: { orderIndex: 'asc' },
      include: { category: true },
    });

    return {
      ok: true as const,
      tripId: tripId.toString(),
      persistedCount: allItems.length,
      createdCount: createdIds.length,
      updatedCount: updatedIds.length,
      items: allItems.map((it) => this.serializeItem(it)),
    };
  }

  async editItem(itemId: bigint, userId: bigint, patch: EditItemDto) {
    const accessItem = await this.tripAccess.assertItemAccess(itemId, userId);
    const tripId = accessItem.checklist.trip.id;
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
      include: { category: true },
    });
    if (!item) throw new NotFoundException(`ChecklistItem ${itemId} not found`);

    const patchedTitle = patch.title ?? item.title;
    const patchedDesc = patch.description !== undefined ? patch.description : item.description;
    const patchedMemo = patch.memo !== undefined ? patch.memo : item.memo;
    const patchedOrder = patch.orderIndex ?? item.orderIndex;
    const patchedScope = (patch.scope as ItemScope | undefined) ?? item.scope;

    const titleChanged = patch.title !== undefined && patch.title !== item.title;
    const descChanged =
      patch.description !== undefined && (patch.description ?? null) !== (item.description ?? null);
    const memoChanged =
      patch.memo !== undefined && (patch.memo ?? null) !== (item.memo ?? null);
    const orderChanged =
      patch.orderIndex !== undefined && patch.orderIndex !== item.orderIndex;
    const scopeChanged = patch.scope !== undefined && patchedScope !== item.scope;

    // 담당자: undefined=변경 없음 / null=해제 / string=지정
    const patchedAssigneeId =
      patch.assigneeUserId === undefined
        ? item.assigneeUserId
        : patch.assigneeUserId === null
          ? null
          : BigInt(patch.assigneeUserId);
    // 개인 짐으로 전환되면 담당자는 의미가 없으므로 자동 해제
    const finalAssigneeId = patchedScope === ItemScope.personal ? null : patchedAssigneeId;
    const assigneeChanged = finalAssigneeId !== item.assigneeUserId;

    if (patch.assigneeUserId != null && patchedScope !== ItemScope.shared) {
      throw new BadRequestException('담당자는 공동 짐에만 지정할 수 있어요.');
    }
    if (assigneeChanged && finalAssigneeId != null) {
      // 담당자는 트립 오너 또는 수락된 멤버여야 한다
      const trip = await this.prisma.trip.findFirst({
        where: { id: tripId },
        select: {
          userId: true,
          members: { where: { status: 'accepted' }, select: { userId: true } },
        },
      });
      const memberIds = new Set<bigint>([
        ...(trip ? [trip.userId] : []),
        ...(trip?.members.map((m) => m.userId) ?? []),
      ]);
      if (!memberIds.has(finalAssigneeId)) {
        throw new BadRequestException('이 여행의 멤버만 담당자로 지정할 수 있어요.');
      }
    }

    if (!titleChanged && !descChanged && !memoChanged && !orderChanged && !scopeChanged && !assigneeChanged) {
      return {
        ok: true as const,
        itemId: item.id.toString(),
        changed: false,
        item: this.serializeItem(item),
      };
    }

    const before = {
      title: item.title,
      description: item.description,
      memo: item.memo,
      orderIndex: item.orderIndex,
      scope: item.scope,
      assigneeUserId: item.assigneeUserId?.toString() ?? null,
    };
    const after = {
      title: patchedTitle,
      description: patchedDesc ?? null,
      memo: patchedMemo ?? null,
      orderIndex: patchedOrder,
      scope: patchedScope,
      assigneeUserId: finalAssigneeId?.toString() ?? null,
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const where: Prisma.ChecklistItemWhereInput = {
        id: itemId,
        deletedAt: null,
        ...(patch.clientUpdatedAt && { updatedAt: new Date(patch.clientUpdatedAt) }),
      };

      const result = await tx.checklistItem.updateMany({ where, data: {
        title: patchedTitle,
        description: patchedDesc ?? null,
        memo: patchedMemo ?? null,
        orderIndex: patchedOrder,
        scope: patchedScope,
        assigneeUserId: finalAssigneeId,
        // 개인↔공동 전환 시 체크 상태는 깔끔하게 초기화 (예측 가능성 우선)
        ...(scopeChanged && { isChecked: false, checkedAt: null }),
      }});

      if (result.count === 0) {
        throw new ConflictException('다른 사용자가 이미 수정했습니다. 최신 데이터를 다시 조회하세요.');
      }

      if (scopeChanged) {
        await tx.checklistItemPersonalCheck.deleteMany({ where: { itemId } });
        await this.recalcTeamCompletion(tx, item.checklistId);
      }

      await tx.checklistItemEdit.create({
        data: {
          itemId,
          userId,
          editType:
            !titleChanged && !descChanged && !memoChanged && !scopeChanged && !assigneeChanged && orderChanged
              ? EditType.reorder
              : EditType.text,
          beforeValue: before as Prisma.InputJsonValue,
          afterValue: after as Prisma.InputJsonValue,
        },
      });

      return tx.checklistItem.findFirst({
        where: { id: itemId },
        include: { category: true },
      });
    }, { timeout: 30000, maxWait: 10000 });

    // 담당자로 새로 지정됐고 본인 지정이 아니면 알림 (fire-and-forget, notify 내부에서 self 차단)
    if (assigneeChanged && finalAssigneeId != null) {
      const trip = await this.prisma.trip.findFirst({
        where: { id: tripId },
        select: { title: true },
      });
      void this.notifications.notify({
        userId: finalAssigneeId,
        type: NotificationType.item_assigned,
        actorId: userId,
        tripId,
        payload: { tripTitle: trip?.title ?? '', itemTitle: patchedTitle },
      });
    }

    this.logger.log(
      `[editItem] item=${itemId} user=${userId} titleChanged=${titleChanged} descChanged=${descChanged} memoChanged=${memoChanged} orderChanged=${orderChanged} scopeChanged=${scopeChanged} assigneeChanged=${assigneeChanged}`,
    );

    return {
      ok: true as const,
      itemId: itemId.toString(),
      changed: true,
      item: this.serializeItem(updated!),
    };
  }

  async deleteItem(itemId: bigint, userId: bigint) {
    // 권한 검사 중앙화 — TripMember 도입 시 TripAccessService만 확장하면 됨
    const item = await this.tripAccess.assertItemAccess(itemId, userId);

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.checklistItem.update({
        where: { id: itemId },
        data: { deletedAt: now },
      }),
      this.prisma.checklistItemEdit.create({
        data: {
          itemId,
          userId,
          editType: EditType.del,
          beforeValue: {
            title: item.title,
            description: item.description,
            orderIndex: item.orderIndex,
          } as Prisma.InputJsonValue,
        },
      }),
    ]);

    this.logger.log(`[deleteItem] item=${itemId} user=${userId}`);

    return {
      ok: true as const,
      itemId: itemId.toString(),
      deletedAt: now.toISOString(),
      message: '항목이 삭제되었습니다.',
    };
  }

  async toggleCheck(itemId: bigint, userId: bigint, action: 'checked' | 'unchecked') {
    const item = await this.tripAccess.assertItemAccess(itemId, userId);

    const now = new Date();
    const desired = action === 'checked';
    const checkAction = desired ? CheckAction.checked : CheckAction.unchecked;

    const { completionRate, newStatus } = await this.prisma.$transaction(async (tx) => {
      if (item.scope === ItemScope.personal) {
        // 개인 짐: 멤버별 상태(personalChecks)만 갱신, 공유 isChecked 는 건드리지 않음
        await tx.checklistItemPersonalCheck.upsert({
          where: { itemId_userId: { itemId, userId } },
          create: { itemId, userId, isChecked: desired, checkedAt: desired ? now : null },
          update: { isChecked: desired, checkedAt: desired ? now : null },
        });
      } else if (item.isChecked !== desired) {
        // 공동 짐: 기존처럼 공유 단일 상태
        await tx.checklistItem.update({
          where: { id: itemId },
          data: { isChecked: desired, checkedAt: desired ? now : null },
        });
      }

      await tx.checklistItemCheck.create({
        data: { itemId, userId, action: checkAction },
      });

      return this.recalcTeamCompletion(tx, item.checklistId);
    }, { timeout: 30000, maxWait: 10000 });

    this.logger.log(
      `[toggleCheck] item=${itemId} user=${userId} action=${action} scope=${item.scope} rate=${completionRate.toFixed(2)}% status=${newStatus}`,
    );

    return {
      ok: true as const,
      itemId: itemId.toString(),
      action,
      scope: item.scope,
      isChecked: desired,
      checkedAt: desired ? now.toISOString() : null,
      occurredAt: now.toISOString(),
    };
  }

  /**
   * 팀 기준 준비율 재계산 — Checklist.completionRate 영속 필드 (어드민/지표용).
   * - 공동(shared) 항목: isChecked ? 1 : 0
   * - 개인(personal) 항목: 체크한 멤버 수 / 전체 멤버 수 (소수 기여)
   * 요청자 기준 준비율(myCompletionRate)은 getByTrip 응답에서 동적 계산한다.
   */
  private async recalcTeamCompletion(
    tx: Prisma.TransactionClient,
    checklistId: bigint,
  ): Promise<{ completionRate: number; newStatus: ChecklistStatus }> {
    const checklist = await tx.checklist.findFirst({
      where: { id: checklistId },
      select: {
        trip: {
          select: {
            userId: true,
            members: { where: { status: 'accepted' }, select: { userId: true } },
          },
        },
        items: {
          where: { isSelected: true, deletedAt: null },
          select: {
            scope: true,
            isChecked: true,
            personalChecks: { where: { isChecked: true }, select: { userId: true } },
          },
        },
      },
    });

    const memberIds = new Set<bigint>([
      ...(checklist ? [checklist.trip.userId] : []),
      ...(checklist?.trip.members.map((m) => m.userId) ?? []),
    ]);
    const memberCount = Math.max(memberIds.size, 1);

    const total = checklist?.items.length ?? 0;
    let progress = 0;
    for (const it of checklist?.items ?? []) {
      if (it.scope === ItemScope.shared) {
        progress += it.isChecked ? 1 : 0;
      } else {
        const checked = it.personalChecks.filter((c) => memberIds.has(c.userId)).length;
        progress += Math.min(checked, memberCount) / memberCount;
      }
    }

    const completionRate = total === 0 ? 0 : (progress / total) * 100;
    const newStatus: ChecklistStatus =
      completionRate === 0
        ? ChecklistStatus.not_started
        : completionRate >= 100
        ? ChecklistStatus.completed
        : ChecklistStatus.preparing;

    await tx.checklist.update({
      where: { id: checklistId },
      data: { status: newStatus, completionRate },
    });

    return { completionRate, newStatus };
  }

  // =========================================================
  // RECLASSIFY (가이드 보관함 항목 재분류)
  // =========================================================

  async reclassifyGuideArchive(
    items: ReclassifyInputItem[],
  ): Promise<{ items: ReclassifiedItem[]; model: string | null }> {
    if (!items || items.length === 0) return { items: [], model: null };
    try {
      const { items: refined, usage } = await this.openai.reclassifyGuideArchiveItems(items);
      this.logger.log(
        `[reclassifyGuideArchive] in=${items.length} out=${refined.length} tokens=${usage.tokens}`,
      );
      return { items: refined, model: usage.model };
    } catch (e) {
      this.logger.error(`[reclassifyGuideArchive] LLM call failed: ${(e as Error).message}`);
      return { items: [], model: null };
    }
  }

  // =========================================================
  // PRIVATE HELPERS
  // =========================================================

  private serializeItem(it: PersistedChecklistItem): GeneratedChecklistItem {
    return {
      id: it.id.toString(),
      title: it.title,
      description: it.description ?? undefined,
      memo: it.memo ?? undefined,
      categoryCode: it.category.code,
      categoryLabel: it.category.labelKo,
      prepType: it.prepType as GeneratedChecklistItem['prepType'],
      baggageType: it.baggageType as GeneratedChecklistItem['baggageType'],
      source: (it.source === ChecklistItemSource.template
        ? 'template'
        : it.source === ChecklistItemSource.llm
          ? 'llm'
          : 'user_added') as 'template' | 'llm' | 'user_added',
      isEssential: false,
      orderIndex: it.orderIndex,
      isSelected: it.isSelected,
      selectedAt: it.selectedAt ? it.selectedAt.toISOString() : null,
      isChecked: it.isChecked,
      scope: it.scope,
      assigneeUserId: it.assigneeUserId?.toString() ?? null,
    };
  }

  private normalizeTitle(title: string): string {
    return title
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[.,/·\-()[\]{}]/g, '');
  }
}
