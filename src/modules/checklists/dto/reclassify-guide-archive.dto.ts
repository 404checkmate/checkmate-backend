import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/**
 * 가이드 보관함 상세 항목 재분류(2차 카테고리) 요청 DTO.
 *
 * 프론트(`GuideArchiveChecklistView.jsx`)가 보관함의 항목들을 base category 만 가진 상태로 보내고,
 * 백엔드는 LLM 으로 더 세분화된 `refinedCategory` / `refinedSubCategory` 를 응답한다.
 */
export class ReclassifyGuideArchiveItemDto {
  @IsString()
  @Length(1, 64)
  id!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  detail?: string;

  /** base category (refine 전). 빈 문자열 허용 — 사용자 직접 추가 항목 등. */
  @IsOptional()
  @IsString()
  @Length(0, 64)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(0, 32)
  prepType?: string;

  @IsOptional()
  @IsString()
  @Length(0, 64)
  subCategory?: string;
}

export class ReclassifyGuideArchiveDto {
  @IsOptional()
  @IsString()
  @Length(0, 64)
  tripId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 64)
  entryId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReclassifyGuideArchiveItemDto)
  items!: ReclassifyGuideArchiveItemDto[];
}
