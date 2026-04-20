import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/**
 * 모든 예외를 표준화된 JSON 응답으로 변환한다.
 *
 * 응답 스키마:
 * {
 *   "success": false,
 *   "error": { "code": string, "message": string, "details"?: unknown },
 *   "path": string,
 *   "timestamp": string
 * }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => unknown };
    }>();
    const req = ctx.getRequest<{ originalUrl: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Unexpected error';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        message = resp;
      } else if (resp && typeof resp === 'object') {
        const r = resp as { message?: unknown; error?: unknown };
        message = Array.isArray(r.message) ? r.message.join(', ') : String(r.message ?? message);
        code = String(r.error ?? exception.name);
        details = r;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.stack);
    }

    res.status(status).json({
      success: false,
      error: { code, message, details },
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    });
  }
}
