import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthProviderName, AuthUser } from '../decorators/current-user.decorator';
import { verifyHs256Jwt, type SupabaseCompatiblePayload } from '../auth/jwt.util';
import { UsersService } from '../../modules/users/users.service';
import { SupabaseService } from '../../infra/supabase/supabase.service';

/**
 * Supabase Auth(그리고 백엔드가 발급한 Supabase 호환 JWT)를 검증하는 전역 Guard.
 *
 * 동작:
 *   1. `@Public()` 핸들러는 무조건 통과.
 *   2. `Authorization: Bearer <token>` → HS256 검증 (`SUPABASE_JWT_SECRET`).
 *   3. HS256 실패(또는 secret 미설정) 시 Supabase admin `auth.getUser(token)` 로 폴백.
 *      └ 2024 말 이후 Supabase 신규 프로젝트는 비대칭 키(ES256/JWKS) 로 서명되는 경우가 많아
 *        HS256 검증만으로는 간헐적으로 `Invalid token` 401 이 발생한다.
 *   4. 검증 성공 시 `(provider, sub)` 로 **JIT 프로비저닝** → `users` + `user_auth_providers` 행 보장.
 *   5. `request.user` 에 `{ supabaseId, userId, email, provider }` 주입.
 *
 * 개발 편의:
 *   - `SUPABASE_JWT_SECRET` 미설정 + `SUPABASE_SERVICE_ROLE_KEY` 도 미설정 + `AUTH_DEV_BYPASS=true`
 *     → 헤더 무시하고 `dev-anon` 통과.
 *   - 운영(`NODE_ENV=production`) 에서는 검증 실패 시 401.
 *
 * 로깅:
 *   - 실패 경로마다 `[auth-guard:*]` 태그 로그를 남겨 어느 검증 단계에서 막혔는지 한눈에 보이도록 한다.
 */
@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseJwtGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
    private readonly supabase: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      method: string;
      originalUrl: string;
      headers: Record<string, string | string[] | undefined>;
      user?: AuthUser;
    }>();
    const reqTag = `[auth-guard] ${req.method} ${req.originalUrl}`;

    const secret = this.config.get<string>('supabase.jwtSecret');
    const isProd = this.config.get<string>('app.nodeEnv') === 'production';
    const devBypass = this.config.get<boolean>('auth.devBypass') ?? true;

    const header = req.headers['authorization'];
    const auth = Array.isArray(header) ? header[0] : header;
    const hasBearer = Boolean(auth && auth.startsWith('Bearer '));
    const token = hasBearer ? auth!.slice('Bearer '.length).trim() : '';

    this.logger.debug(
      `${reqTag} hasBearer=${hasBearer} tokenLen=${token.length} tokenPrefix=${token.slice(0, 8)}`,
    );

    // ------ dev bypass 경로 ------
    if (!secret) {
      if (isProd) {
        this.logger.error(`${reqTag} [prod] SUPABASE_JWT_SECRET 미설정 → 401`);
        throw new UnauthorizedException('JWT secret not configured');
      }
      if (!devBypass) {
        this.logger.error(`${reqTag} [dev] devBypass=false + secret 미설정 → 401`);
        throw new UnauthorizedException('JWT secret not configured');
      }
      this.logger.warn(`${reqTag} dev-anon 통과 (secret 미설정, devBypass=true)`);
      req.user = { supabaseId: 'dev-anon', userId: null, email: null, provider: null };
      return true;
    }

    if (!hasBearer) {
      this.logger.warn(`${reqTag} Authorization 헤더 없음 또는 형식 이상 → 401`);
      throw new UnauthorizedException('Missing Bearer token');
    }

    // ------ 1차: HS256 (legacy JWT secret) ------
    let payload: SupabaseCompatiblePayload | null = verifyHs256Jwt(token, secret);
    let verifyPath: 'hs256' | 'supabase-admin' = 'hs256';

    if (!payload) {
      this.logger.warn(
        `${reqTag} HS256 검증 실패 → Supabase admin getUser 로 폴백 시도 ` +
          `(신규 프로젝트의 비대칭 키 / 만료 / 서명 변경 가능성)`,
      );

      // ------ 2차: Supabase admin `getUser(token)` 폴백 ------
      payload = await this.verifyViaSupabaseAdmin(token, reqTag);
      if (!payload) {
        this.logger.error(`${reqTag} HS256 + Supabase admin 모두 실패 → 401`);
        throw new UnauthorizedException('Invalid token');
      }
      verifyPath = 'supabase-admin';
    }

    const sub = String(payload.sub ?? '');
    if (!sub) {
      this.logger.error(`${reqTag} payload.sub 없음 → 401`);
      throw new UnauthorizedException('Invalid token: missing sub');
    }

    const email =
      typeof payload.email === 'string'
        ? payload.email
        : typeof (payload.user_metadata as Record<string, unknown> | undefined)?.email === 'string'
          ? ((payload.user_metadata as Record<string, unknown>).email as string)
          : null;

    const provider = this.extractProvider(payload as unknown as Record<string, unknown>);

    this.logger.log(
      `${reqTag} 검증 OK via=${verifyPath} sub=${sub} provider=${provider ?? '(none)'} email=${email ?? '(none)'}`,
    );

    // JIT 프로비저닝 — users + user_auth_providers 보장.
    let userId: bigint | null = null;
    if (provider) {
      try {
        const users = await this.moduleRef.get(UsersService, { strict: false });
        const user = await users.findOrCreateFromSocialLogin({
          provider,
          providerUserId: sub,
          email,
          name: this.pickString(payload.user_metadata, ['name', 'full_name', 'nickname']),
          avatarUrl: this.pickString(payload.user_metadata, ['avatar_url', 'picture']),
        });
        userId = user.id;
        this.logger.debug(`${reqTag} JIT 프로비저닝 OK userId=${userId}`);
      } catch (err) {
        this.logger.warn(
          `${reqTag} JIT 프로비저닝 실패 sub=${sub}: ${(err as Error).message}`,
        );
      }
    } else {
      this.logger.warn(
        `${reqTag} provider 추출 실패(app_metadata.provider 없음) — 비소셜 토큰으로 간주`,
      );
    }

    req.user = { supabaseId: sub, userId, email, provider };
    return true;
  }

  /**
   * Supabase admin 클라이언트로 토큰을 검증한다.
   * - 내부적으로 `/auth/v1/user` 호출 → 비대칭 키로 서명된 JWT 도 검증 가능.
   * - 성공 시 HS256 payload 스키마와 호환되는 객체로 정규화해서 반환.
   */
  private async verifyViaSupabaseAdmin(
    token: string,
    reqTag: string,
  ): Promise<SupabaseCompatiblePayload | null> {
    let admin;
    try {
      admin = this.supabase.admin;
    } catch (err) {
      this.logger.error(
        `${reqTag} Supabase admin 클라이언트 없음(SERVICE_ROLE_KEY 미설정?): ${(err as Error).message}`,
      );
      return null;
    }
    try {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data?.user) {
        this.logger.warn(
          `${reqTag} Supabase getUser 실패: ${error?.message ?? 'no user'}`,
        );
        return null;
      }
      const u = data.user;
      return {
        sub: u.id,
        email: u.email ?? undefined,
        app_metadata: (u.app_metadata ?? {}) as Record<string, unknown>,
        user_metadata: (u.user_metadata ?? {}) as Record<string, unknown>,
      };
    } catch (err) {
      this.logger.error(`${reqTag} Supabase getUser 예외: ${(err as Error).message}`);
      return null;
    }
  }

  private extractProvider(
    payload: Record<string, unknown>,
  ): AuthProviderName | null {
    const candidates = [
      (payload.app_metadata as Record<string, unknown> | undefined)?.provider,
      payload.provider,
    ];
    for (const c of candidates) {
      if (typeof c === 'string') {
        const v = c.toLowerCase();
        if (v === 'google' || v === 'kakao') return v;
      }
    }
    return null;
  }

  private pickString(
    obj: unknown,
    keys: string[],
  ): string | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const o = obj as Record<string, unknown>;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  }
}
