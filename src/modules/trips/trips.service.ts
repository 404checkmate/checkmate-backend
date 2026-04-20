import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class TripsService {
  constructor(private readonly prisma: PrismaService) {}

  listByUser(userId: bigint) {
    return this.prisma.trip.findMany({
      where: { userId, deletedAt: null },
      orderBy: { tripStart: 'desc' },
      include: {
        country: true,
        cities: { include: { city: true }, orderBy: { orderIndex: 'asc' } },
        travelStyles: { include: { travelStyle: true } },
        companions: { include: { companionType: true } },
        checklist: true,
      },
    });
  }

  async findOne(tripId: bigint) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      include: {
        country: true,
        cities: { include: { city: true }, orderBy: { orderIndex: 'asc' } },
        flights: true,
        travelStyles: { include: { travelStyle: true } },
        companions: { include: { companionType: true } },
        checklist: { include: { items: true } },
      },
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    return trip;
  }
}
