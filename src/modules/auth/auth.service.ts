import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { UsersService } from '../users/users.service';
import { signSupabaseCompatibleJwt } from '../../common/auth/jwt.util';

/**
 * 네이버 프로필 응답 (resultcode="00" 성공 시 response 내부).
 */
interface NaverProfile {
  id: string;
  email?: string;
  name?: string;
  nickname?: string;
  profile_image?: string;
}

/**
 * 네이버 토큰 교환 응답.
 */
interface NaverTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: string;
  error?: string;
  error_description?: string;
}

/**
 * 인증 관련 백엔드 서비스.
 *
 * 현재 범위:
 * - 네이버 OAuth 중개 (Supabase 미지원이라 백엔드가 직접 처리)
 * - 네이버 로그인 성공 후 Supabase 호환 JWT 발급 → 프론트가 동일 스키마로 사용
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  // ------------------------------------------------------------------
  // Naver OAuth 중개
  // ------------------------------------------------------------------

  /**
   * 네이버 인증 페이지로 이동시킬 URL.
   * CSRF 방지용 state 는 호출자가 일회용으로 저장(쿠키/세션) 후 콜백에서 검증.
   */
  buildNaverAuthorizeUrl(state: string): string {
    const clientId = this.requireConfig('naver.clientId', 'NAVER_CLIENT_ID');
    const redirectUri = this.requireConfig('naver.redirectUri', 'NAVER_REDIRECT_URI');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `https://nid.naver.com/oauth2.0/authorize?${params.toString()}`;
  }

  generateState(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * 네이버 콜백 처리:
   * 1. code → access_token 교환
   * 2. access_token → 프로필 조회
   * 3. JIT 프로비저닝 (users + user_auth_providers)
   * 4. Supabase 호환 JWT 발급
   *
   * 반환: 프론트 `/auth/callback` 으로 리다이렉트할 full URL (access_token 을 fragment 로 첨부).
   */
  async handleNaverCallback(params: { code: string; state: string }): Promise<{
    redirectUrl: string;
    accessToken: string;
    expiresInSec: number;
  }> {
    const clientId = this.requireConfig('naver.clientId', 'NAVER_CLIENT_ID');
    const clientSecret = this.requireConfig('naver.clientSecret', 'NAVER_CLIENT_SECRET');
    const jwtSecret = this.requireConfig('supabase.jwtSecret', 'SUPABASE_JWT_SECRET');

    const tokenRes = await this.exchangeNaverCode({
      code: params.code,
      state: params.state,
      clientId,
      clientSecret,
    });
    if (!tokenRes.access_token) {
      throw new UnauthorizedException(
        `Naver token exchange failed: ${tokenRes.error ?? 'unknown'} ${tokenRes.error_description ?? ''}`.trim(),
      );
    }

    const profile = await this.fetchNaverProfile(tokenRes.access_token);
    if (!profile.id) {
      throw new UnauthorizedException('Naver profile missing id');
    }

    // Supabase 스키마와 통일 — sub 를 deterministic UUID v5 대신, 제공자+id 해시로 생성.
    // (Supabase 의 sub 와 충돌하지 않도록 'naver:' prefix 는 사용하지 않고, DB user_auth_providers 에만 실제 id 를 저장)
    const subUuid = this.deterministicUuidFromNaverId(profile.id);

    const user = await this.users.findOrCreateFromSocialLogin({
      provider: 'naver',
      providerUserId: profile.id,
      email: profile.email ?? null,
      name: profile.name ?? profile.nickname,
      avatarUrl: profile.profile_image,
    });

    // Supabase 호환 JWT 발급 (SupabaseJwtGuard 가 동일 경로로 검증).
    const expiresInSec = 60 * 60; // 1h
    const accessToken = signSupabaseCompatibleJwt(
      {
        sub: subUuid,
        email: user.email,
        app_metadata: { provider: 'naver' },
        user_metadata: {
          name: user.nickname,
          avatar_url: user.profileImageUrl ?? undefined,
        },
      },
      jwtSecret,
      { expiresInSec, issuer: 'checkmate-backend' },
    );

    const callbackBase = this.config.get<string>('auth.frontendCallbackUrl');
    if (!callbackBase) {
      throw new InternalServerErrorException('FRONTEND_AUTH_CALLBACK_URL not configured');
    }

    // Supabase OAuth 콜백과 유사한 hash fragment 규약으로 전달.
    const fragment = new URLSearchParams({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: String(expiresInSec),
      provider: 'naver',
    }).toString();

    return {
      redirectUrl: `${callbackBase}#${fragment}`,
      accessToken,
      expiresInSec,
    };
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async exchangeNaverCode(input: {
    code: string;
    state: string;
    clientId: string;
    clientSecret: string;
  }): Promise<NaverTokenResponse> {
    const url = new URL('https://nid.naver.com/oauth2.0/token');
    url.searchParams.set('grant_type', 'authorization_code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('client_secret', input.clientSecret);
    url.searchParams.set('code', input.code);
    url.searchParams.set('state', input.state);

    const res = await fetch(url.toString(), { method: 'GET' });
    const body = (await res.json()) as NaverTokenResponse;
    if (!res.ok) {
      this.logger.warn(
        `Naver token endpoint returned ${res.status}: ${JSON.stringify(body)}`,
      );
    }
    return body;
  }

  private async fetchNaverProfile(accessToken: string): Promise<NaverProfile> {
    const res = await fetch('https://openapi.naver.com/v1/nid/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json()) as {
      resultcode?: string;
      message?: string;
      response?: NaverProfile;
    };
    if (body.resultcode !== '00' || !body.response) {
      throw new UnauthorizedException(
        `Naver profile fetch failed: ${body.resultcode} ${body.message ?? ''}`.trim(),
      );
    }
    return body.response;
  }

  /**
   * Naver user id (숫자 문자열) → 결정적 UUID v5 유사 값.
   * Supabase UUID 와 동일한 형태(36자, 하이픈) 로 맞춰 sub claim 의 타입 일관성을 유지.
   */
  private deterministicUuidFromNaverId(naverId: string): string {
    const h = createHash('sha256').update(`naver:${naverId}`).digest('hex');
    // xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx (version 5 + variant)
    const v = h.slice(0, 32);
    const timeLow = v.slice(0, 8);
    const timeMid = v.slice(8, 12);
    const timeHi = '5' + v.slice(13, 16);
    // variant: 10xx
    const y = ((parseInt(v.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
    const clockSeq = y + v.slice(17, 20);
    const node = v.slice(20, 32);
    return `${timeLow}-${timeMid}-${timeHi}-${clockSeq}-${node}`;
  }

  private requireConfig(key: string, envName: string): string {
    const v = this.config.get<string>(key);
    if (!v) {
      throw new InternalServerErrorException(`${envName} is not configured`);
    }
    return v;
  }
}
