import { IsBoolean, IsOptional } from 'class-validator';

/**
 * POST /api/users/me/consent — 약관/개인정보 동의 수락.
 *
 * 호출 시점을 `users.legal_consent_accepted_at` 에 기록하고,
 * `marketingOptIn` 값을 `users.marketing_opt_in` 으로 영속화한다.
 * 필수 약관은 별도 플래그 없이 "엔드포인트 호출 자체" 로 동의한 것으로 간주한다.
 */
export class AcceptConsentDto {
  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;
}
