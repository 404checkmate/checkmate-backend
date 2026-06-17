import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpsertAffiliateLinkDto {
  @IsIn(['coupang', 'mrt'])
  provider!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
