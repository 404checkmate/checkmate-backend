import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * SupabaseJwtGuard 에서 주입한 사용자 정보를 핸들러 파라미터로 꺼낸다.
 *
 * 예:
 *   @Get('me')
 *   getMe(@CurrentUser() user: AuthUser) { ... }
 */
export type AuthProviderName = 'google' | 'kakao';

export interface AuthUser {
  /** Supabase Auth UUID (sub claim) */
  supabaseId: string;
  /** DB 내 users.id (Guard 가 JIT 프로비저닝 후 주입) */
  userId: bigint | null;
  email: string | null;
  /** 소셜 제공자 — JWT `app_metadata.provider` 또는 `provider` 커스텀 클레임 */
  provider: AuthProviderName | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    return request.user;
  },
);
