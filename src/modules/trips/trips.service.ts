import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Trip, TripStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import type {
  TripCityInputDto,
  TripCompanionInputDto,
  TripFlightInputDto,
  TripTravelStyleInputDto,
} from './dto/create-trip.dto';

/**
 * Prisma include 결과를 타입으로 뽑아두면 리턴 타입이 명확해진다.
 */
const tripDetailInclude = {
  country: true,
  cities: { include: { city: true }, orderBy: { orderIndex: 'asc' } },
  flights: true,
  companions: { include: { companionType: true } },
  travelStyles: { include: { travelStyle: true } },
  checklist: true,
} satisfies Prisma.TripInclude;

export type TripDetail = Prisma.TripGetPayload<{ include: typeof tripDetailInclude }>;

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // =========================
  // READ
  // =========================
  listByUser(userId: bigint): Promise<TripDetail[]> {
    return this.prisma.trip.findMany({
      // 내 소유 + 내가 멤버로 합류한 트립 (공동 편집)
      where: {
        deletedAt: null,
        OR: [{ userId }, { members: { some: { userId } } }],
      },
      orderBy: { tripStart: 'desc' },
      include: tripDetailInclude,
    });
  }

  async findOne(tripId: bigint, userId: bigint): Promise<TripDetail> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      include: tripDetailInclude,
    });
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    if (trip.userId !== userId) {
      // 멤버(공동 편집)면 조회 허용
      const member = await this.prisma.tripMember.findUnique({
        where: { tripId_userId: { tripId, userId } },
        select: { id: true },
      });
      if (!member) throw new ForbiddenException('조회 권한이 없습니다.');
    }
    return trip;
  }

  // =========================
  // CREATE
  // =========================
  async create(dto: CreateTripDto): Promise<TripDetail> {
    this.assertDateRange(dto.tripStart, dto.tripEnd);

    if (!dto.userId) {
      throw new BadRequestException('userId 가 비어있습니다. 인증 상태를 확인하세요.');
    }
    const userId = BigInt(dto.userId);
    const country = await this.resolveCountry(dto.countryCode);
    const cityRows = await this.resolveCityInputs(dto.cities, country.id);
    const companionRows = await this.resolveCompanionInputs(dto.companions ?? []);
    const styleRows = await this.resolveStyleInputs(dto.travelStyles ?? []);
    this.assertFlightsConsistency(dto.bookingStatus, dto.flights ?? []);

    const created = await this.prisma.$transaction(async (tx) => {
      const trip = await tx.trip.create({
        data: {
          userId,
          countryId: country.id,
          title: dto.title,
          tripStart: new Date(dto.tripStart),
          tripEnd: new Date(dto.tripEnd),
          bookingStatus: dto.bookingStatus,
          status: dto.status ?? TripStatus.planning,
        },
      });

      if (cityRows.length) {
        await tx.tripCity.createMany({
          data: cityRows.map((c) => ({
            tripId: trip.id,
            cityId: c.cityId,
            customCityName: c.customCityName,
            orderIndex: c.orderIndex,
            visitStart: c.visitStart,
            visitEnd: c.visitEnd,
            isAutoSynced: c.isAutoSynced,
          })),
        });
      }

      if (dto.flights?.length) {
        await tx.tripFlight.createMany({
          data: dto.flights.map((f) => this.toFlightRow(trip.id, f)),
        });
      }

      if (companionRows.length) {
        await tx.tripCompanion.createMany({
          data: companionRows.map((c) => ({
            tripId: trip.id,
            companionTypeId: c.companionTypeId,
            hasPet: c.hasPet,
          })),
        });
      }

      if (styleRows.length) {
        await tx.tripTravelStyle.createMany({
          data: styleRows.map((s) => ({
            tripId: trip.id,
            travelStyleId: s.travelStyleId,
          })),
        });
      }

      return trip;
    });

    this.logger.log(`trip created id=${created.id} user=${userId} country=${country.code}`);
    return this.findOne(created.id, userId);
  }

  // =========================
  // UPDATE (partial)
  // =========================
  async update(tripId: bigint, userId: bigint, dto: UpdateTripDto): Promise<TripDetail> {
    const existing = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException(`Trip ${tripId} not found`);
    if (existing.userId !== userId) throw new ForbiddenException('수정 권한이 없습니다.');

    if (dto.tripStart && dto.tripEnd) {
      this.assertDateRange(dto.tripStart, dto.tripEnd);
    }

    const country = dto.countryCode ? await this.resolveCountry(dto.countryCode) : null;
    const cityRows = dto.cities
      ? await this.resolveCityInputs(dto.cities, country?.id ?? existing.countryId)
      : null;
    const companionRows = dto.companions ? await this.resolveCompanionInputs(dto.companions) : null;
    const styleRows = dto.travelStyles ? await this.resolveStyleInputs(dto.travelStyles) : null;
    if (dto.flights) {
      this.assertFlightsConsistency(
        dto.bookingStatus ?? existing.bookingStatus,
        dto.flights,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const where: Prisma.TripWhereInput = {
        id: tripId,
        deletedAt: null,
        ...(dto.clientUpdatedAt && {
          updatedAt: new Date(dto.clientUpdatedAt),
        }),
      };
      const result = await tx.trip.updateMany({
        where,
        data: {
          title: dto.title ?? undefined,
          countryId: country?.id ?? undefined,
          tripStart: dto.tripStart ? new Date(dto.tripStart) : undefined,
          tripEnd: dto.tripEnd ? new Date(dto.tripEnd) : undefined,
          bookingStatus: dto.bookingStatus ?? undefined,
          status: dto.status ?? undefined,
        },
      });
      if (result.count === 0) {
        throw new ConflictException(
          '다른 사용자가 이미 수정했습니다. 최신 데이터를 다시 조회하세요.',
        );
      }

      if (cityRows) {
        await tx.tripCity.deleteMany({ where: { tripId } });
        if (cityRows.length) {
          await tx.tripCity.createMany({
            data: cityRows.map((c) => ({
              tripId,
              cityId: c.cityId,
              customCityName: c.customCityName,
              orderIndex: c.orderIndex,
              visitStart: c.visitStart,
              visitEnd: c.visitEnd,
              isAutoSynced: c.isAutoSynced,
            })),
          });
        }
      }

      if (dto.flights) {
        await tx.tripFlight.deleteMany({ where: { tripId } });
        if (dto.flights.length) {
          await tx.tripFlight.createMany({
            data: dto.flights.map((f) => this.toFlightRow(tripId, f)),
          });
        }
      }

      if (companionRows) {
        await tx.tripCompanion.deleteMany({ where: { tripId } });
        if (companionRows.length) {
          await tx.tripCompanion.createMany({
            data: companionRows.map((c) => ({
              tripId,
              companionTypeId: c.companionTypeId,
              hasPet: c.hasPet,
            })),
          });
        }
      }

      if (styleRows) {
        await tx.tripTravelStyle.deleteMany({ where: { tripId } });
        if (styleRows.length) {
          await tx.tripTravelStyle.createMany({
            data: styleRows.map((s) => ({
              tripId,
              travelStyleId: s.travelStyleId,
            })),
          });
        }
      }
    });

    return this.findOne(tripId, userId);
  }

  // =========================
  // DELETE (soft)
  // =========================
  async softDelete(
    tripId: bigint,
    userId: bigint,
  ): Promise<{ id: string; deletedAt: Date; message: string }> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
    });
    if (!trip) throw new NotFoundException('여행을 찾을 수 없습니다.');
    if (trip.userId !== userId) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }
    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: { deletedAt: new Date() },
    });
    return {
      id: updated.id.toString(),
      deletedAt: updated.deletedAt!,
      message: '여행이 삭제되었습니다.',
    };
  }

  // =========================
  // helpers
  // =========================
  private assertDateRange(start: string, end: string) {
    if (new Date(start).getTime() > new Date(end).getTime()) {
      throw new BadRequestException('tripStart 가 tripEnd 보다 이후일 수 없습니다.');
    }
  }

  private assertFlightsConsistency(
    bookingStatus: Trip['bookingStatus'],
    flights: TripFlightInputDto[],
  ) {
    if (bookingStatus === 'not_booked' && flights.length > 0) {
      throw new BadRequestException(
        'bookingStatus=not_booked 인 경우 flights 를 함께 보낼 수 없습니다.',
      );
    }
  }

  private toFlightRow(tripId: bigint, f: TripFlightInputDto) {
    if (new Date(f.departAt).getTime() > new Date(f.arriveAt).getTime()) {
      throw new BadRequestException(`[flight ${f.flightNo}] departAt 이 arriveAt 이후입니다.`);
    }
    return {
      tripId,
      direction: f.direction,
      flightNo: f.flightNo.toUpperCase(),
      airline: f.airline,
      departureIata: f.departureIata.toUpperCase(),
      arrivalIata: f.arrivalIata.toUpperCase(),
      departAt: new Date(f.departAt),
      arriveAt: new Date(f.arriveAt),
    };
  }

  private async resolveCountry(code: string) {
    const country = await this.prisma.country.findUnique({
      where: { code: code.toUpperCase() },
    });
    if (!country) {
      throw new BadRequestException(`알 수 없는 countryCode: ${code}`);
    }
    return country;
  }

  /**
   * 프론트가 보낸 도시 입력(iata/cityId/customCityName)을 실제 city 행으로 매핑한다.
   * DB에 없는 도시의 경우 cityId=null + customCityName 으로 저장한다.
   * 오류 상황:
   *   - iata/cityId/customCityName 모두 비어있음
   *   - DB 조회 결과 없고 customCityName 도 없음
   */
  private async resolveCityInputs(cities: TripCityInputDto[], expectedCountryId: bigint) {
    if (!cities.length) return [];

    for (const c of cities) {
      if (!c.cityIata && !c.cityId && !c.customCityName?.trim()) {
        throw new BadRequestException(
          'cities[*] 는 cityIata, cityId, customCityName 중 하나가 필수입니다.',
        );
      }
    }

    const iataCodes = cities
      .filter((c) => c.cityIata)
      .map((c) => c.cityIata!.toUpperCase());

    const cityIds = cities
      .filter((c) => c.cityId)
      .map((c) => BigInt(c.cityId!));

    let byIata = new Map<string, { id: bigint; iataCode: string | null; nameEn: string; countryId: bigint }>();
    let byId = new Map<string, { id: bigint; iataCode: string | null; nameEn: string; countryId: bigint }>();

    if (iataCodes.length > 0 || cityIds.length > 0) {
      const rows = await this.prisma.city.findMany({
        where: {
          OR: [
            ...(iataCodes.length ? [{ iataCode: { in: iataCodes } }] : []),
            ...(cityIds.length ? [{ id: { in: cityIds } }] : []),
          ],
        },
      });
      byIata = new Map(rows.filter((r) => r.iataCode).map((r) => [r.iataCode!, r]));
      byId = new Map(rows.map((r) => [r.id.toString(), r]));
    }

    const result: Array<{
      cityId: bigint | null;
      customCityName: string | null;
      orderIndex: number;
      visitStart: Date | null;
      visitEnd: Date | null;
      isAutoSynced: boolean;
    }> = cities.map((c) => {
      const row = c.cityIata
        ? byIata.get(c.cityIata.toUpperCase())
        : c.cityId
        ? byId.get(String(c.cityId))
        : undefined;

      if (!row) {
        // DB 미등록 도시 — customCityName 으로 저장
        const name = c.customCityName?.trim() ?? null;
        if (!name) {
          throw new BadRequestException(
            `존재하지 않는 도시: ${c.cityIata ?? `#${c.cityId}`}`,
          );
        }
        return {
          cityId: null,
          customCityName: name,
          orderIndex: c.orderIndex,
          visitStart: c.visitStart ? new Date(c.visitStart) : null,
          visitEnd: c.visitEnd ? new Date(c.visitEnd) : null,
          isAutoSynced: c.isAutoSynced ?? false,
        };
      }

      if (row.countryId !== expectedCountryId) {
        this.logger.warn(
          `city ${row.id}(${row.nameEn}) 의 countryId 가 요청 국가와 다릅니다. 허용하되 경고만 기록합니다.`,
        );
      }
      return {
        cityId: row.id,
        customCityName: null,
        orderIndex: c.orderIndex,
        visitStart: c.visitStart ? new Date(c.visitStart) : null,
        visitEnd: c.visitEnd ? new Date(c.visitEnd) : null,
        isAutoSynced: c.isAutoSynced ?? false,
      };
    });

    const orders = result.map((r) => r.orderIndex);
    if (new Set(orders).size !== orders.length) {
      throw new BadRequestException('cities[*].orderIndex 는 서로 달라야 합니다.');
    }
    return result;
  }

  private async resolveCompanionInputs(items: TripCompanionInputDto[]) {
    if (!items.length) return [];
    const rows = await this.prisma.companionType.findMany({
      where: { code: { in: items.map((i) => i.companionCode) } },
    });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const missing = items.filter((i) => !byCode.has(i.companionCode));
    if (missing.length) {
      throw new BadRequestException(
        `알 수 없는 companionCode: ${missing.map((m) => m.companionCode).join(', ')}`,
      );
    }
    return items.map((i) => ({
      companionTypeId: byCode.get(i.companionCode)!.id,
      hasPet: i.hasPet ?? false,
    }));
  }

  private async resolveStyleInputs(items: TripTravelStyleInputDto[]) {
    if (!items.length) return [];
    const rows = await this.prisma.travelStyle.findMany({
      where: { code: { in: items.map((i) => i.styleCode) } },
    });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const missing = items.filter((i) => !byCode.has(i.styleCode));
    if (missing.length) {
      throw new BadRequestException(
        `알 수 없는 styleCode: ${missing.map((m) => m.styleCode).join(', ')}`,
      );
    }
    return items.map((i) => ({ travelStyleId: byCode.get(i.styleCode)!.id }));
  }
}
