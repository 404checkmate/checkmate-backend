import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CreateGuideArchiveDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  snapshot?: unknown;

  @IsOptional()
  @IsBoolean()
  isAiRecommended?: boolean;
}
