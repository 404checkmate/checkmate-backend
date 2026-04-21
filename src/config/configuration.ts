/**
 * 타입 안전한 환경변수 접근 레이어.
 * 모든 환경변수 참조는 이 파일을 통해서만 이루어져야 한다.
 */
export default () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '8080', 10),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
  },
  auth: {
    // 소셜 로그인(Google/Kakao) 성공 후 프론트로 리다이렉트할 콜백 URL.
    // 프론트 `/auth/callback` 에서 Supabase 세션을 확정한다.
    frontendCallbackUrl:
      process.env.FRONTEND_AUTH_CALLBACK_URL ?? 'http://localhost:5173/auth/callback',
    // Dev 바이패스 (SUPABASE_JWT_SECRET 미설정 시 dev-anon 으로 통과)
    devBypass: (process.env.AUTH_DEV_BYPASS ?? 'true') === 'true',
  },
  db: {
    url: process.env.DATABASE_URL ?? '',
    directUrl: process.env.DIRECT_URL ?? '',
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? '',
  },
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'openai',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  },
});
