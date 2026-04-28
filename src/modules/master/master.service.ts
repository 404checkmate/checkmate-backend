import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class MasterService {
  constructor(private readonly prisma: PrismaService) {}

  listCountries(q?: string) {
    return this.prisma.country.findMany({
      where: q
        ? {
            OR: [
              { nameKo: { contains: q, mode: 'insensitive' } },
              { nameEn: { contains: q, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { nameKo: 'asc' },
    });
  }

  listCities(params: { q?: string; countryId?: string; onlyServed?: string }) {
    const { q, countryId, onlyServed } = params;
    return this.prisma.city.findMany({
      where: {
        ...(countryId ? { countryId: BigInt(countryId) } : {}),
        ...(onlyServed === 'true' ? { isServed: true } : {}),
        ...(q
          ? {
              OR: [
                { nameKo: { contains: q, mode: 'insensitive' } },
                { nameEn: { contains: q, mode: 'insensitive' } },
                { iataCode: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { country: true },
      orderBy: { nameKo: 'asc' },
    });
  }

  listServedCities(q?: string) {
    return this.prisma.city.findMany({
      where: {
        isServed: true,
        ...(q
          ? {
              OR: [
                { nameKo: { contains: q, mode: 'insensitive' } },
                { nameEn: { contains: q, mode: 'insensitive' } },
                { iataCode: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { country: true },
      orderBy: { nameKo: 'asc' },
      take: 10,
    });
  }

  listChecklistCategories() {
    return this.prisma.checklistCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  listTravelStyles() {
    return this.prisma.travelStyle.findMany({ orderBy: { code: 'asc' } });
  }

  listCompanionTypes() {
    return this.prisma.companionType.findMany({ orderBy: { id: 'asc' } });
  }
}
