import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * POST /api/checklists/generate-from-context 의 요청 바디.
 *
 * - `destination` 은 프롬프트에 그대로 삽입되므로 자연어(예: "베트남 (다낭, 호이안)") 로 보내도 OK.
 * - `durationDays` 는 여행 일수(1 이상).
 * - `season` 이 비어 있으면 서버가 tripStart(있을 경우) 기반으로 추정.
 * - `companions` / `purposes` 는 선택값(빈 배열 허용).
 */
export class GenerateFromContextDto {
  @IsString()
  @Length(1, 200)
  destination!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  season?: string;

  /** YYYY-MM-DD — season 이 비어 있을 때 서버 추정용 (선택) */
  @IsOptional()
  @IsString()
  tripStart?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  companions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  purposes?: string[];
}
