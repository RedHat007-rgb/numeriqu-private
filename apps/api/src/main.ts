import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.useGlobalFilters(new AllExceptionsFilter());

  // Production-grade validation for DTOs and incoming requests
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  
  // Diagnostic Request Logger (Observability)
  app.use((req: any, _res: any, next: any) => {
    logger.log(`[NETWORK] ${req.method} ${req.originalUrl}`);
    next();
  });

  // CORS: Allow only configured origins (comma-separated env var)
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : ['http://localhost:3001'];

  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Graceful shutdown: close DB pools, ClickHouse connections, in-flight syncs
  app.enableShutdownHooks();

  // Global request timeout (5min) — SSE streams for AI advisory need longer connections
  const server = app.getHttpServer();
  server.setTimeout(300_000);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);
}
void bootstrap();
