import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Gender } from '@prisma/client';
import { UsersService } from './users.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { UpdateMeDto } from './dto/update-me.dto';
import { AcceptConsentDto } from './dto/accept-consent.dto';

@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.requireById(BigInt(id));
  }

  /**
   * 온보딩 프로필 수정.
   * `SupabaseJwtGuard` 가 JIT 프로비저닝까지 마쳤기 때문에 userId 가 있어야 한다.
   * dev-anon 처럼 userId 가 없는 세션이면 400 으로 명시한다.
   */
  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: UpdateMeDto,
  ) {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException(
        'JIT 프로비저닝이 아직 안 된 세션입니다. 소셜 로그인 후 다시 시도하세요.',
      );
    }

    const updated = await this.users.updateProfile(user.userId, {
      nickname: dto.nickname,
      gender: dto.gender as Gender | undefined,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      profileImageUrl: dto.profileImageUrl,
    });

    return {
      user: {
        id: updated.id,
        email: updated.email,
        nickname: updated.nickname,
        profileImageUrl: updated.profileImageUrl,
        gender: updated.gender,
        birthDate: updated.birthDate,
      },
    };
  }

  /**
   * 약관/개인정보 동의 수락.
   *
   * - `users.legal_consent_accepted_at` 에 현재 시각을 기록
   * - `users.marketing_opt_in` 에 body.marketingOptIn(default false) 를 기록
   *
   * 프론트 `AuthConsentPage` 에서 /onboarding 진입 직전에 1회 호출한다.
   * 재호출해도 안전(멱등) 하도록 설계되어 있다.
   */
  @Post('me/consent')
  async acceptConsent(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: AcceptConsentDto,
  ) {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException(
        'JIT 프로비저닝이 아직 안 된 세션입니다. 소셜 로그인 후 다시 시도하세요.',
      );
    }

    const updated = await this.users.acceptConsent(user.userId, {
      marketingOptIn: dto.marketingOptIn,
    });

    return {
      ok: true,
      userId: updated.id,
      acceptedAt: updated.legalConsentAcceptedAt?.toISOString() ?? null,
      marketingOptIn: updated.marketingOptIn,
    };
  }
}
