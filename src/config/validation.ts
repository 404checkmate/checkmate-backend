import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  API_PREFIX: z.string().default('api'),
  CORS_ORIGIN: z.string().default('*'),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional().or(z.literal('')),

  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_ANON_KEY: z.string().optional().or(z.literal('')),
  SUPABASE_JWT_SECRET: z.string().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('')),

  FRONTEND_AUTH_CALLBACK_URL: z.string().url().optional().or(z.literal('')),
  AUTH_DEV_BYPASS: z.enum(['true', 'false']).default('true'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().or(z.literal('')),

  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'gemini']).default('openai'),
  LLM_API_KEY: z.string().optional().or(z.literal('')),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * NestJS ConfigModule 의 `validate` 훅.
 * 잘못된 env 는 부팅 시 즉시 실패시키도록 예외를 던진다.
 */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => ` - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[env] 환경변수 검증 실패:\n${issues}`);
  }
  return parsed.data;
}
