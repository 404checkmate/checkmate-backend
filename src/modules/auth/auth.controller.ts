import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly users: UsersService) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true, service: 'auth' };
  }

  /**
   * 현재 사용자 세션 요약. Guard 가 JIT 프로비저닝까지 마쳤으므로 userId 가 채워져 있음.
   * - 프론트는 로그인 직후 이 엔드포인트로 본인 기본 프로필을 가져옴.
   * - BigInt 는 `main.ts` 의 toJSON 패치로 문자열 직렬화.
   */
  @Get('me')
  async me(@CurrentUser() user: AuthUser | undefined) {
    if (!user) return { user: null };
    if (user.userId == null) {
      // dev-anon 또는 JIT 실패 케이스 — 프론트는 onboarding 유도.
      return {
        user: {
          supabaseId: user.supabaseId,
          email: user.email,
          provider: user.provider,
          profile: null,
        },
      };
    }
    const profile = await this.users.findById(user.userId);
    return {
      user: {
        supabaseId: user.supabaseId,
        email: user.email,
        provider: user.provider,
        profile: profile
          ? {
              id: profile.id,
              email: profile.email,
              nickname: profile.nickname,
              profileImageUrl: profile.profileImageUrl,
              gender: profile.gender,
              birthDate: profile.birthDate,
              createdAt: profile.createdAt,
            }
          : null,
      },
    };
  }
}
