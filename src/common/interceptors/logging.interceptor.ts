import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ method: string; originalUrl: string }>();
    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          this.logger.log(`${req.method} ${req.originalUrl} +${ms}ms`);
        },
        error: (err: unknown) => {
          const ms = Date.now() - start;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`${req.method} ${req.originalUrl} +${ms}ms failed: ${msg}`);
        },
      }),
    );
  }
}
