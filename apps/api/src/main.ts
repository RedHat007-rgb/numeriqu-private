import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // ── Global Exception Filter ──────────────────────────────────────────────
  // Catches ALL unhandled errors and converts them to user-friendly messages.
  // Raw stack traces, DB errors, and internal details are NEVER exposed.
  app.useGlobalFilters(new AllExceptionsFilter());

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`
╔══════════════════════════════════════════════════════════════╗
║  Numeriqu Intelligence Server                                ║
║  ─────────────────────────────────────────────────────────── ║
║  Port: ${String(port).padEnd(53)}║
║  RAG Layer:    POST /rag/query    (independent)              ║
║  Agent Layer:  POST /agent/query  (independent)              ║
║  Analytics:    GET  /analytics/insights                      ║
║  Legacy:       POST /ai/query     (deprecated, backward compat)║
║  Health:       GET  /rag/health   GET /agent/health           ║
╚══════════════════════════════════════════════════════════════╝
  `);
}
void bootstrap();
