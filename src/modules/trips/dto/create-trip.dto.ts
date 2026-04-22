import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BookingStatus, FlightDirection, TripStatus } from '@prisma/client';

/**
 * 방문 도시 (Step4 입력).
 * 프론트는 IATA 코드로 도시를 식별하므로 `cityIata` 를 기본 키로 사용하되,
 * IATA 가 없는 도시는 `cityId` 를 직접 받도록 허용한다.
 */
export class TripCityInputDto {
  @IsOptional()
  @IsString()
  @Length(3, 3)
  cityIata?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  cityId?: number;

  @IsInt()
  @Min(0)
  orderIndex!: number;

  @IsOptional()
  @IsDateString()
  visitStart?: string;

  @IsOptional()
  @IsDateString()
  visitEnd?: string;

  @IsOptional()
  @IsBoolean()
  isAutoSynced?: boolean;
}

/**
 * 항공편 (Step3 입력, 예매한 경우에만).
 */
export class TripFlightInputDto {
  @IsEnum(FlightDirection)
  direction!: FlightDirection;

  @IsString()
  @Matches(/^[A-Z]{2}\d{1,4}[A-Z]?$/i, {
    message: 'flightNo 형식이 올바르지 않습니다. (예: KE101, VN401, OZ851)',
  })
  flightNo!: string;

  @IsString()
  airline!: string;

  @IsString()
  @Length(3, 3)
  departureIata!: string;

  @IsString()
  @Length(3, 3)
  arrivalIata!: string;

  /** ISO 8601: 2026-08-01T09:30:00+09:00 */
  @IsDateString()
  departAt!: string;

  @IsDateString()
  arriveAt!: string;
}

/**
 * 동행 (Step5 입력). 프론트 UI 는 단일 선택이지만 스키마는 배열이다.
 * ERD 의 `trip_companions.has_pet` 은 "반려동물 동반 여부" — 동행 유형과는 별개 플래그.
 */
export class TripCompanionInputDto {
  @IsString()
  companionCode!: string;

  @IsOptional()
  @IsBoolean()
  hasPet?: boolean;
}

/**
 * 여행 스타일 (Step5 입력, 다중).
 */
export class TripTravelStyleInputDto {
  @IsString()
  styleCode!: string;
}

export class CreateTripDto {
  /**
   * 레거시/개발용 fallback.
   * 기본적으로는 `SupabaseJwtGuard` 가 주입한 `req.user.userId` 가 사용되며,
   * Controller 에서 이 필드가 있더라도 JWT 값으로 덮어쓴다.
   * (인증이 꺼진 개발 환경·스크립트에서만 의미 있음)
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  userId?: number;

  /** ISO-3166 alpha-2 (예: 'VN', 'JP') */
  @IsString()
  @Length(2, 2)
  countryCode!: string;

  @IsString()
  @Length(1, 100)
  title!: string;

  @IsDateString()
  tripStart!: string;

  @IsDateString()
  tripEnd!: string;

  @IsEnum(BookingStatus)
  bookingStatus!: BookingStatus;

  @IsOptional()
  @IsEnum(TripStatus)
  status?: TripStatus;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TripCityInputDto)
  cities!: TripCityInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => TripFlightInputDto)
  flights?: TripFlightInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => TripCompanionInputDto)
  companions?: TripCompanionInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TripTravelStyleInputDto)
  travelStyles?: TripTravelStyleInputDto[];
}
