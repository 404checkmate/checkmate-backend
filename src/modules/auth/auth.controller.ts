import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

const NAVER_STATE_COOKIE = 'cm_naver_state';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

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

  // ------------------------------------------------------------------
  // Naver OAuth 중개 (Supabase 미지원)
  // ------------------------------------------------------------------

  /** 네이버 로그인 시작 — 인증 URL 로 302 리다이렉트, state 를 HttpOnly 쿠키로 보관. */
  @Public()
  @Get('naver/login')
  naverLogin(@Res() res: Response) {
    const state = this.auth.generateState();
    const isProd = this.config.get<string>('app.nodeEnv') === 'production';
    res.cookie(NAVER_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    res.redirect(this.auth.buildNaverAuthorizeUrl(state));
  }

  /**
   * 네이버 콜백 — 토큰 교환 + JIT + JWT 발급 후 프론트로 리다이렉트.
   * 실패 시에도 프론트 `/auth/callback?error=...` 로 리다이렉트하여 UX 일관.
   */
  @Public()
  @Get('naver/callback')
  async naverCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontendCallback = this.config.get<string>('auth.frontendCallbackUrl');
    if (!frontendCallback) {
      throw new InternalServerErrorException('FRONTEND_AUTH_CALLBACK_URL not configured');
    }

    const savedState = this.readCookie(req, NAVER_STATE_COOKIE);
    res.clearCookie(NAVER_STATE_COOKIE, { path: '/' });

    if (oauthError) {
      return res.redirect(
        `${frontendCallback}#${new URLSearchParams({ error: oauthError }).toString()}`,
      );
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code/state');
    }
    if (!savedState || savedState !== state) {
      return res.redirect(
        `${frontendCallback}#${new URLSearchParams({ error: 'invalid_state' }).toString()}`,
      );
    }

    try {
      const result = await this.auth.handleNaverCallback({ code, state });
      return res.redirect(result.redirectUrl);
    } catch (err) {
      const msg = (err as Error).message ?? 'naver_login_failed';
      return res.redirect(
        `${frontendCallback}#${new URLSearchParams({ error: 'naver_login_failed', message: msg }).toString()}`,
      );
    }
  }

  /** `cookie-parser` 미사용 — Cookie 헤더를 수동 파싱. */
  private readCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    const parts = header.split(';');
    for (const p of parts) {
      const [k, ...rest] = p.trim().split('=');
      if (k === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
  }
}
