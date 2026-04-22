import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

const PREP_TYPES = ['item', 'pre_booking', 'pre_departure_check', 'ai_recommend'] as const;
const BAGGAGE_TYPES = ['carry_on', 'checked', 'none'] as const;
const SOURCES = ['template', 'llm', 'user_added'] as const;

export class UpsertItemDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @IsString()
  categoryCode!: string;

  @IsIn(PREP_TYPES as unknown as string[])
  prepType!: (typeof PREP_TYPES)[number];

  @IsIn(BAGGAGE_TYPES as unknown as string[])
  baggageType!: (typeof BAGGAGE_TYPES)[number];

  @IsIn(SOURCES as unknown as string[])
  source!: (typeof SOURCES)[number];

  @IsInt()
  @Min(0)
  orderIndex!: number;
}

export class UpsertItemsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UpsertItemDto)
  items!: UpsertItemDto[];
}

export class EditItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;
}

export class CheckItemDto {
  @IsIn(['checked', 'unchecked'])
  action!: 'checked' | 'unchecked';
}
