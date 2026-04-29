import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Supabase 호환 HS256 JWT 유틸.
 *
 * - 검증: Google/Kakao 소셜 로그인은 Supabase 가 발급한 토큰을 이 유틸로 검증한다.
 * - 서명: 현재는 백엔드에서 JWT 를 직접 발급하는 플로우가 없다.
 *   (향후 커스텀 JWT 발급이 필요해지면 `signSupabaseCompatibleJwt` 를 재사용.)
 */

export interface SupabaseCompatiblePayload {
  sub: string;
  email?: string;
  role?: string;
  aud?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  exp?: number;
  iat?: number;
  iss?: string;
  jti?: string;
}

// 모듈 레벨 JWKS 캐시 — createRemoteJWKSet 내부에서도 키를 캐싱하므로 URI당 1회만 생성한다.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _jwksUri = '';

function getJwks(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const uri = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  if (!_jwks || _jwksUri !== uri) {
    _jwks = createRemoteJWKSet(new URL(uri));
    _jwksUri = uri;
  }
  return _jwks;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(input: string): Buffer {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * Supabase 호환 HS256 JWT 를 발급한다.
 * - iat/exp 는 초 단위 유닉스 타임스탬프. 기본 만료 1시간.
 * - role 기본 `authenticated`, aud 기본 `authenticated` (Supabase 와 동일).
 */
export function signSupabaseCompatibleJwt(
  payload: Omit<SupabaseCompatiblePayload, 'iat' | 'exp'>,
  secret: string,
  opts?: { expiresInSec?: number; issuer?: string },
): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = opts?.expiresInSec ?? 60 * 60;

  const full: SupabaseCompatiblePayload = {
    role: 'authenticated',
    aud: 'authenticated',
    iss: opts?.issuer ?? 'checkmate-backend',
    jti: randomUUID(),
    iat: now,
    exp: now + expiresIn,
    ...payload,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(full));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const s = base64url(sig);
  return `${h}.${p}.${s}`;
}

/**
 * JWT 헤더만 디코딩해서 반환. 서명 검증 없이 alg 등을 사전 확인할 때 사용.
 */
export function readJwtHeader(token: string): Record<string, unknown> | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  try {
    return JSON.parse(base64urlDecode(token.slice(0, dot)).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * HS256 JWT 를 검증하고 payload 를 반환. 실패 시 null.
 * - 서명/만료만 검증. `aud`/`iss` 는 호출자가 필요 시 추가 검증.
 */
export function verifyHs256Jwt(
  token: string,
  secret: string,
): SupabaseCompatiblePayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(h).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const provided = base64urlDecode(s);
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: SupabaseCompatiblePayload;
  try {
    payload = JSON.parse(base64urlDecode(p).toString('utf8')) as SupabaseCompatiblePayload;
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp) return null;
  return payload;
}

/**
 * ES256 JWT 를 Supabase JWKS 공개키로 로컬 검증하고 payload 를 반환. 실패 시 null.
 * - createRemoteJWKSet 이 키를 인메모리 캐싱하므로 첫 요청 이후 추가 HTTP 없음.
 */
export async function verifyEs256Jwt(
  token: string,
  supabaseUrl: string,
): Promise<SupabaseCompatiblePayload | null> {
  if (!supabaseUrl) return null;
  try {
    const JWKS = getJwks(supabaseUrl);
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
    const p = payload as Record<string, unknown>;
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      email: typeof p['email'] === 'string' ? p['email'] : undefined,
      role: typeof p['role'] === 'string' ? p['role'] : undefined,
      aud: Array.isArray(payload.aud)
        ? String(payload.aud[0])
        : typeof payload.aud === 'string'
          ? payload.aud
          : undefined,
      app_metadata: (p['app_metadata'] as Record<string, unknown> | undefined) ?? {},
      user_metadata: (p['user_metadata'] as Record<string, unknown> | undefined) ?? {},
      exp: payload.exp,
      iat: payload.iat,
      iss: payload.iss,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}
