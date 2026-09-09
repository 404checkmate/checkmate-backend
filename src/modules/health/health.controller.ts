import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 외부 모니터(UptimeRobot / cron-job.org)가 주기적으로 때리는 핑.
   *
   * 단순 200 이 아니라 DB 쿼리를 한 번 태우는 이유:
   * - Render 무료 인스턴스는 15분 무요청이면 잠들어 다음 요청에 30~60초가 걸린다.
   * - Supabase 무료 프로젝트는 7일 무활동이면 일시정지된다.
   * 한 번의 핑으로 둘 다 깨워두려면 실제로 DB 를 건드려야 한다.
   *
   * 인증 없이 열려 있어야 외부 모니터가 호출할 수 있으므로 `@Public()`.
   */
  @Public()
  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, db: 'up', at: new Date().toISOString() };
  }
}
