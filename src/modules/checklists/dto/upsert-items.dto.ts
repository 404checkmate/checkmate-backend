import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

const PREP_TYPES = ['item', 'pre_booking', 'pre_departure_check', 'ai_recommend', 'etc'] as const;
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
  @IsString()
  @Length(0, 1000)
  memo?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;

  @IsOptional()
  @IsISO8601()
  clientUpdatedAt?: string;

  /** 개인/공동 짐 전환. 전환 시 체크 상태는 초기화된다. */
  @IsOptional()
  @IsIn(['personal', 'shared'])
  scope?: 'personal' | 'shared';

  /**
   * 공동 짐 담당자 (stringified userId). null 이면 담당자 해제.
   * scope=shared 인 항목(또는 이번 patch 로 shared 가 되는 항목)에만 허용.
   * IsOptional 은 null 도 통과시키므로 해제(null) 표현이 가능하다.
   */
  @IsOptional()
  @IsNumberString()
  assigneeUserId?: string | null;
}

export class CheckItemDto {
  @IsIn(['checked', 'unchecked'])
  action!: 'checked' | 'unchecked';
}
