import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BookingStatus, TripStatus } from '@prisma/client';
import {
  TripCityInputDto,
  TripCompanionInputDto,
  TripFlightInputDto,
  TripTravelStyleInputDto,
} from './create-trip.dto';

/**
 * Trip 부분 수정용.
 * 배열(`cities`, `flights`, `companions`, `travelStyles`)이 넘어오면
 * 해당 배열은 "전체 교체"로 간주한다 (기존 행 삭제 후 재삽입).
 * 배열을 보내지 않으면 그 관계는 변경되지 않는다.
 */
export class UpdateTripDto {
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;

  @IsOptional()
  @IsDateString()
  tripStart?: string;

  @IsOptional()
  @IsDateString()
  tripEnd?: string;

  @IsOptional()
  @IsEnum(BookingStatus)
  bookingStatus?: BookingStatus;

  @IsOptional()
  @IsEnum(TripStatus)
  status?: TripStatus;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TripCityInputDto)
  cities?: TripCityInputDto[];

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

  @IsOptional()
  @IsISO8601()
  clientUpdatedAt?: string;
}
