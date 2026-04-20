import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class MasterService {
  constructor(private readonly prisma: PrismaService) {}

  listCountries() {
    return this.prisma.country.findMany({ orderBy: { nameKo: 'asc' } });
  }

  listCities(countryId?: bigint, onlyServed = false) {
    return this.prisma.city.findMany({
      where: {
        ...(countryId ? { countryId } : {}),
        ...(onlyServed ? { isServed: true } : {}),
      },
      orderBy: { nameKo: 'asc' },
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
