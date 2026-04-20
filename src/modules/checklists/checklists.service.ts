import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class ChecklistsService {
  constructor(private readonly prisma: PrismaService) {}

  async getByTrip(tripId: bigint) {
    const checklist = await this.prisma.checklist.findUnique({
      where: { tripId },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: { orderIndex: 'asc' },
          include: { category: true },
        },
      },
    });
    if (!checklist) throw new NotFoundException(`Checklist for trip ${tripId} not found`);
    return checklist;
  }
}
