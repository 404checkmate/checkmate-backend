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
import { verifyHs256Jwt } from '../auth/jwt.util';
import { UsersService } from '../../modules/users/users.service';

/**
 * Supabase Auth(그리고 백엔드가 발급한 Supabase 호환 JWT)를 검증하는 전역 Guard.
 *
 * 동작:
 *   1. `@Public()` 핸들러는 무조건 통과.
 *   2. `Authorization: Bearer <token>` → HS256 검증 (`SUPABASE_JWT_SECRET`).
 *   3. 검증 성공 시 `(provider, sub)` 로 **JIT 프로비저닝** → `users` + `user_auth_providers` 행 보장.
 *   4. `request.user` 에 `{ supabaseId, userId, email, provider }` 주입.
 *
 * 개발 편의:
 *   - `SUPABASE_JWT_SECRET` 미설정 + `AUTH_DEV_BYPASS=true` (기본 dev 환경) → 헤더 무시하고 `dev-anon` 통과.
 *   - 운영(`NODE_ENV=production`) 에서는 시크릿 필수 + 바이패스 비허용.
 */
@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseJwtGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthUser;
    }>();

    const secret = this.config.get<string>('supabase.jwtSecret');
    const isProd = this.config.get<string>('app.nodeEnv') === 'production';
    const devBypass = this.config.get<boolean>('auth.devBypass') ?? true;

    if (!secret) {
      if (isProd) throw new UnauthorizedException('JWT secret not configured');
      if (!devBypass) throw new UnauthorizedException('JWT secret not configured');
      req.user = { supabaseId: 'dev-anon', userId: null, email: null, provider: null };
      return true;
    }

    const header = req.headers['authorization'];
    const auth = Array.isArray(header) ? header[0] : header;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = auth.slice('Bearer '.length).trim();

    const payload = verifyHs256Jwt(token, secret);
    if (!payload) throw new UnauthorizedException('Invalid token');

    const sub = String(payload.sub ?? '');
    if (!sub) throw new UnauthorizedException('Invalid token: missing sub');

    const email =
      typeof payload.email === 'string'
        ? payload.email
        : typeof (payload.user_metadata as Record<string, unknown> | undefined)?.email === 'string'
          ? ((payload.user_metadata as Record<string, unknown>).email as string)
          : null;

    const provider = this.extractProvider(payload as unknown as Record<string, unknown>);

    // JIT 프로비저닝 — users + user_auth_providers 보장.
    // Public 이 아니면서 인증에 성공한 모든 요청에서 실행. 향후 per-request 캐시로 최적화 가능.
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
      } catch (err) {
        this.logger.warn(`JIT provisioning failed for sub=${sub}: ${(err as Error).message}`);
      }
    }

    req.user = { supabaseId: sub, userId, email, provider };
    return true;
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
