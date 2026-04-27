import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import configuration from './config/configuration';
import { validateEnv } from './config/validation';

import { PrismaModule } from './infra/prisma/prisma.module';
import { SupabaseModule } from './infra/supabase/supabase.module';

import { SupabaseJwtGuard } from './common/guards/supabase-jwt.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MasterModule } from './modules/master/master.module';
import { TripsModule } from './modules/trips/trips.module';
import { ChecklistsModule } from './modules/checklists/checklists.module';
import { LlmModule } from './modules/llm/llm.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { GuideArchivesModule } from './modules/guide-archives/guide-archives.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 },
    ]),
    PrismaModule,
    SupabaseModule,

    AuthModule,
    UsersModule,
    MasterModule,
    TripsModule,
    ChecklistsModule,
    LlmModule,
    AnalyticsModule,
    GuideArchivesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: SupabaseJwtGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
