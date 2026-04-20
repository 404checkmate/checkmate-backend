import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

// BigInt 는 기본적으로 JSON 직렬화가 불가능하므로, 문자열로 변환하여 내보낸다.
// 프론트엔드 JS number 안전 범위(2^53) 밖으로 나갈 가능성에 대비한 방어책.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port', 8080);
  const apiPrefix = config.get<string>('app.apiPrefix', 'api');
  const corsOrigin = config.get<string>('app.corsOrigin', '*');

  app.setGlobalPrefix(apiPrefix);
  app.use(helmet());
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(port);
  Logger.log(`🚀 Checkmate API listening on http://localhost:${port}/${apiPrefix}`, 'Bootstrap');
}

bootstrap();
