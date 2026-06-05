import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuthProvider, Gender, User } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SupabaseService } from '../../infra/supabase/supabase.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
  ) {}

  /**
   * 회원탈퇴 — 개인정보 익명화(소프트 삭제) + 관계 데이터 정리 + Supabase auth 계정 삭제.
   *
   * - 내 트립은 소프트 삭제 (멤버였던 친구들도 접근 불가)
   * - 친구 관계/초대, 트립 멤버십/초대는 하드 삭제
   * - email 은 unique 충돌 방지를 위해 치환 (재가입 시 새 계정 생성)
   * - 분석 이벤트(user_events)는 서비스 통계용으로 비식별 상태 유지
   */
  async deleteMe(userId: bigint, supabaseId: string | null) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('이미 탈퇴했거나 존재하지 않는 계정입니다.');

    const now = new Date();
    await this.prisma.$transaction([
      // 친구 도메인 정리
      this.prisma.friendship.deleteMany({
        where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      }),
      this.prisma.friendInvite.deleteMany({ where: { creatorId: userId } }),
      // 공동 편집 도메인 정리 — 내가 멤버인 행 + 내 트립에 붙은 멤버/초대
      this.prisma.tripMember.deleteMany({
        where: { OR: [{ userId }, { trip: { userId } }] },
      }),
      this.prisma.tripInvite.deleteMany({
        where: { OR: [{ createdBy: userId }, { trip: { userId } }] },
      }),
      // 내 트립 소프트 삭제
      this.prisma.trip.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: now },
      }),
      // 소셜 로그인 연결 제거 (재로그인 시 새 계정으로 프로비저닝)
      this.prisma.userAuthProvider.deleteMany({ where: { userId } }),
      // 개인정보 익명화 + 소프트 삭제
      this.prisma.user.update({
        where: { id: userId },
        data: {
          deletedAt: now,
          email: `deleted_${userId}@removed.checkmate`,
          nickname: '탈퇴한 사용자',
          profileImageUrl: null,
          gender: Gender.unknown,
          birthDate: null,
          marketingOptIn: false,
        },
      }),
    ]);

    // Supabase auth 계정 삭제 — 실패해도 DB 익명화는 완료된 상태라 경고만 남김
    if (supabaseId) {
      try {
        await this.supabase.admin.auth.admin.deleteUser(supabaseId);
      } catch (err) {
        this.logger.warn(
          `[deleteMe] supabase auth 삭제 실패 user=${userId} sub=${supabaseId}: ${(err as Error)?.message}`,
        );
      }
    }

    this.logger.log(`user deleted (anonymized) id=${userId}`);
    return { ok: true as const, message: '탈퇴가 완료되었습니다.' };
  }

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

  async getOne(targetId: bigint, requesterId: bigint) {
    const user = await this.prisma.user.findFirst({
      where: { id: targetId, deletedAt: null },
    });
    if (!user) throw new NotFoundException(`User ${targetId} not found`);

    if (targetId === requesterId) {
      return {
        id: user.id.toString(),
        email: user.email,
        nickname: user.nickname,
        profileImageUrl: user.profileImageUrl,
        gender: user.gender,
        birthDate: user.birthDate,
        onboardingCompletedAt: user.onboardingCompletedAt,
        legalConsentAcceptedAt: user.legalConsentAcceptedAt,
        marketingOptIn: user.marketingOptIn,
        createdAt: user.createdAt,
      };
    }

    return {
      id: user.id.toString(),
      nickname: user.nickname,
      profileImageUrl: user.profileImageUrl,
    };
  }

  /**
   * 온보딩 프로필 수정. 전달된 필드만 업데이트한다.
   * (Prisma 특성상 undefined 는 no-op, null 은 컬럼을 비우는 의미)
   *
   * 추가 동작: 이번 업데이트로 처음 "gender(!=unknown) + birthDate" 가 모두
   * 채워지는 순간 `onboardingCompletedAt` 을 현재 시각으로 스탬프한다.
   * 이미 스탬프된 사용자는 건드리지 않는다(멱등).
   */
  async updateProfile(
    id: bigint,
    patch: {
      nickname?: string;
      gender?: import('@prisma/client').Gender;
      birthDate?: Date;
      profileImageUrl?: string;
    },
  ) {
    const user = await this.requireById(id);
    this.logger.log(
      `updateProfile user=${user.id} keys=${Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined).join(',')}`,
    );

    // 업데이트 이후(머지된) 프로필로 온보딩 완료 여부 계산.
    const mergedGender = patch.gender ?? user.gender;
    const mergedBirth = patch.birthDate ?? user.birthDate ?? null;
    const isOnboardingComplete =
      mergedGender !== 'unknown' && mergedBirth !== null;
    const shouldStamp =
      isOnboardingComplete && user.onboardingCompletedAt == null;

    return this.prisma.user.update({
      where: { id },
      data: {
        nickname: patch.nickname ?? undefined,
        gender: patch.gender ?? undefined,
        birthDate: patch.birthDate ?? undefined,
        profileImageUrl: patch.profileImageUrl ?? undefined,
        onboardingCompletedAt: shouldStamp ? new Date() : undefined,
      },
    });
  }

  /**
   * 약관/개인정보 동의 수락 기록.
   *
   * - `legalConsentAcceptedAt` 에 현재 시각 스탬프 (재호출 시 최신 시각으로 덮어씀)
   * - `marketingOptIn` 은 전달값 그대로(기본 false)
   *
   * 재호출을 허용하는 이유: 프론트가 재로그인·재진입 플로우에서 한 번 더
   * /consent 를 태울 수 있도록 멱등하게 동작해야 하기 때문.
   */
  async acceptConsent(
    id: bigint,
    input: { marketingOptIn?: boolean },
  ) {
    await this.requireById(id);
    const now = new Date();
    const marketingOptIn = Boolean(input.marketingOptIn);
    this.logger.log(
      `acceptConsent user=${id} marketingOptIn=${marketingOptIn}`,
    );
    return this.prisma.user.update({
      where: { id },
      data: {
        legalConsentAcceptedAt: now,
        marketingOptIn,
      },
      select: {
        id: true,
        legalConsentAcceptedAt: true,
        marketingOptIn: true,
      },
    });
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
