import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true, service: 'auth' };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser | undefined) {
    return { user: user ?? null };
  }
}
