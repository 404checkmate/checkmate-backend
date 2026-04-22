import { Gender } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, IsString, Length } from 'class-validator';

/**
 * PATCH /api/users/me — 온보딩 프로필 수정용.
 * 모든 필드 optional. 보내준 값만 부분 업데이트한다.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 30)
  nickname?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  /** YYYY-MM-DD */
  @IsOptional()
  @IsISO8601({ strict: false })
  birthDate?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  profileImageUrl?: string;
}
