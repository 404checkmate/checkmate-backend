import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

export type TripAccessLevel = 'view' | 'edit' | 'owner';
export type TripRole = 'owner' | 'editor';

/**
 * 트립 접근 권한 중앙 검사 (docs/collab-checklist-plan.md).
 *
 * - 소유자: Trip.userId (TripMember 행 없음)
 * - 멤버: TripMember(tripId, userId) — 현재 editor 단일 롤이라 view/edit 동등
 * - need='owner' 는 멤버 관리·삭제 등 소유자 전용 작업에 사용
 */
@Injectable()
export class TripAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** tripId 기준 접근 검사 — 통과 시 trip(id, userId)과 요청자 role 반환 */
  async assertTripAccess(
    tripId: bigint,
    userId: bigint,
    need: TripAccessLevel = 'edit',
  ): Promise<{ id: bigint; userId: bigint; role: TripRole }> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);

    if (trip.userId === userId) {
      return { ...trip, role: 'owner' };
    }
    if (need === 'owner') {
      throw new ForbiddenException('여행 소유자만 할 수 있는 작업이에요.');
    }

    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new ForbiddenException('이 여행에 대한 권한이 없습니다.');
    }
    return { ...trip, role: 'editor' };
  }

  /** itemId → checklist → trip 경로로 접근 검사 — 통과 시 item(+checklist.trip) 반환 */
  async assertItemAccess(itemId: bigint, userId: bigint) {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
      include: {
        checklist: {
          include: {
            trip: { select: { id: true, userId: true, deletedAt: true } },
          },
        },
      },
    });
    if (!item) throw new NotFoundException(`ChecklistItem ${itemId} not found`);
    const trip = item.checklist.trip;
    if (trip.deletedAt !== null) {
      throw new ForbiddenException('이 여행에 대한 권한이 없습니다.');
    }
    if (trip.userId !== userId) {
      const member = await this.prisma.tripMember.findUnique({
        where: { tripId_userId: { tripId: trip.id, userId } },
        select: { id: true },
      });
      if (!member) {
        throw new ForbiddenException('이 여행에 대한 권한이 없습니다.');
      }
    }
    return item;
  }
}
