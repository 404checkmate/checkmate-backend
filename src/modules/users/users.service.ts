import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuthProvider, User } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AuthProviderName } from '../../common/decorators/current-user.decorator';

export interface SocialLoginIdentity {
  provider: AuthProviderName;
  /** 제공자별 고유 식별자 (Supabase Auth 의 user `sub` UUID). */
  providerUserId: string;
  email: string | null;
  name?: string;
  avatarUrl?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  findById(id: bigint) {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { passports: true, authProviders: false },
    });
  }

  async requireById(id: bigint) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  findByEmail(email: string) {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  /**
   * 소셜 로그인 identity → DB 사용자 JIT 프로비저닝.
   *
   * 전략:
   * 1. `(provider, providerUserId)` 로 `user_auth_providers` 조회 → 있으면 해당 user 반환.
   * 2. 없으면 email 로 `users` 조회(이미 다른 provider 로 가입한 계정과 병합).
   * 3. 둘 다 없으면 `users` + `user_auth_providers` 신규 생성 (단일 트랜잭션).
   *
   * nickname 폴백 순서: identity.name → email prefix → "여행자".
   */
  async findOrCreateFromSocialLogin(identity: SocialLoginIdentity): Promise<User> {
    const provider = this.toEnumProvider(identity.provider);

    // 1) 기존 provider 링크
    const existingLink = await this.prisma.userAuthProvider.findUnique({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId: identity.providerUserId,
        },
      },
      include: { user: true },
    });
    if (existingLink?.user && !existingLink.user.deletedAt) {
      return existingLink.user;
    }

    // 2) 이메일 병합 (같은 사람이 다른 SNS 로 추가 연결)
    if (identity.email) {
      const existingByEmail = await this.prisma.user.findFirst({
        where: { email: identity.email, deletedAt: null },
      });
      if (existingByEmail) {
        await this.prisma.userAuthProvider.upsert({
          where: {
            provider_providerUserId: {
              provider,
              providerUserId: identity.providerUserId,
            },
          },
          create: {
            userId: existingByEmail.id,
            provider,
            providerUserId: identity.providerUserId,
            accessTokenHash: this.hashIdentifier(identity.providerUserId),
          },
          update: {},
        });
        return existingByEmail;
      }
    }

    // 3) 신규 생성
    const email = identity.email ?? this.syntheticEmail(provider, identity.providerUserId);
    const nickname = this.resolveNickname(identity);

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          nickname,
          profileImageUrl: identity.avatarUrl ?? null,
        },
      });
      await tx.userAuthProvider.create({
        data: {
          userId: user.id,
          provider,
          providerUserId: identity.providerUserId,
          accessTokenHash: this.hashIdentifier(identity.providerUserId),
        },
      });
      return user;
    });

    this.logger.log(
      `JIT provisioned user id=${created.id} email=${email} provider=${provider}`,
    );
    return created;
  }

  private toEnumProvider(p: AuthProviderName): AuthProvider {
    switch (p) {
      case 'google':
        return AuthProvider.google;
      case 'kakao':
        return AuthProvider.kakao;
    }
  }

  private resolveNickname(identity: SocialLoginIdentity): string {
    if (identity.name && identity.name.trim().length > 0) return identity.name.trim();
    if (identity.email) {
      const prefix = identity.email.split('@')[0];
      if (prefix && prefix.length > 0) return prefix;
    }
    return '여행자';
  }

  /**
   * 이메일 미제공 제공자 대비 합성 email (unique 충돌 방지용 placeholder).
   * 이후 온보딩 단계에서 사용자가 실제 이메일을 기입하면 갱신.
   */
  private syntheticEmail(provider: AuthProvider, providerUserId: string): string {
    return `${provider}_${providerUserId}@social.checkmate.local`;
  }

  /** `access_token_hash` 컬럼 NOT NULL 충족용. 실제 access_token 은 저장하지 않는다. */
  private hashIdentifier(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
