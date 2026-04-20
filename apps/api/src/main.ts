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
  const parseOrigins = (raw: string | undefined) =>
    (raw ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

  const fromEnv = parseOrigins(
    process.env.CORS_ORIGINS || process.env.WEB_APP_URL,
  );

  /** Local Next ports; always merged in non-production so WEB_APP_URL=3001 alone does not block 3010. */
  const localWebOrigins = [
    'http://localhost:3010',
    'http://localhost:3001',
    'http://127.0.0.1:3010',
    'http://127.0.0.1:3001',
  ];

  const allowedOrigins =
    process.env.NODE_ENV === 'production'
      ? fromEnv
      : [...new Set([...localWebOrigins, ...fromEnv])];

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type,Authorization',
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
║  Health:       GET  /rag/health   GET /agent/health          ║
╚══════════════════════════════════════════════════════════════╝
  `);
}

// Prisma schema hot-reload cache breaker
console.log('Reloading server architecture to ingest V2 Postgres entities...');

void bootstrap();
