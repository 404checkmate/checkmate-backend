import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../decorators/current-user.decorator';

/**
 * 관리자 전용 라우트 가드.
 * 전역 SupabaseJwtGuard 가 먼저 request.user 를 채운 뒤 실행되므로
 * 여기서는 이메일이 ADMIN_EMAILS 허용 목록에 있는지만 확인한다.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const email = request.user?.email?.toLowerCase();
    const adminEmails = this.config.get<string[]>('admin.adminEmails') ?? [];
    if (!email || !adminEmails.includes(email)) {
      throw new ForbiddenException('관리자 권한이 필요합니다.');
    }
    return true;
  }
}
