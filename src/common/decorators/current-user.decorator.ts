import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * SupabaseJwtGuard 에서 주입한 사용자 정보를 핸들러 파라미터로 꺼낸다.
 *
 * 예:
 *   @Get('me')
 *   getMe(@CurrentUser() user: AuthUser) { ... }
 */
export interface AuthUser {
  /** Supabase Auth UUID (sub claim) */
  supabaseId: string;
  /** DB 내 users.id (JWT 커스텀 클레임 또는 매핑 조회 결과) */
  userId: bigint | null;
  email: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    return request.user;
  },
);
