import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'crypto';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthUser } from '../decorators/current-user.decorator';

/**
 * Supabase Auth 가 발급한 JWT(HS256)를 검증하는 전역 Guard.
 *
 * 동작:
 *   1. `@Public()` 가 달린 핸들러는 무조건 통과.
 *   2. Authorization: Bearer <token> 헤더를 읽고, HS256 시그니처를
 *      `SUPABASE_JWT_SECRET` 으로 검증.
 *   3. payload.sub, payload.email 을 `request.user` 에 주입.
 *
 * NOTE: 운영 환경에서는 `jose` 라이브러리 + JWKS 캐시를 쓰는 것을 권장.
 *       여기서는 추가 의존성 없이 동작하도록 최소 구현만 포함한다.
 */
@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseJwtGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthUser;
    }>();

    const header = req.headers['authorization'];
    const auth = Array.isArray(header) ? header[0] : header;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = auth.slice('Bearer '.length).trim();

    const secret = this.config.get<string>('supabase.jwtSecret');
    if (!secret) {
      // 개발 환경에서 Supabase 미설정 시, JWT 없이도 부팅 가능하도록 허용.
      if (this.config.get<string>('app.nodeEnv') !== 'production') {
        this.logger.warn('SUPABASE_JWT_SECRET 미설정 — dev 모드에서 검증을 건너뜁니다.');
        req.user = { supabaseId: 'dev-anon', userId: null, email: null };
        return true;
      }
      throw new UnauthorizedException('JWT secret not configured');
    }

    const payload = this.verifyHs256(token, secret);
    if (!payload) throw new UnauthorizedException('Invalid token');

    req.user = {
      supabaseId: String(payload.sub ?? ''),
      userId: null, // 필요 시 users 테이블 매핑 후 주입 (Interceptor/Service 단에서)
      email: typeof payload.email === 'string' ? payload.email : null,
    };
    return true;
  }

  private verifyHs256(token: string, secret: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = this.decodeJson(encodedHeader);
    if (!header || header.alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const provided = Buffer.from(
      encodedSignature.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    if (expected.length !== provided.length) return null;
    if (!timingSafeEqual(expected, provided)) return null;

    const payload = this.decodeJson(encodedPayload);
    if (!payload) return null;
    if (typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp) return null;
    return payload;
  }

  private decodeJson(base64url: string): Record<string, unknown> | null {
    try {
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
      const text = Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
