// Deploy trigger: 2026-07-17 — no-op change to rebuild the API image from latest main.
import { config as loadEnvFile } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { resolveLlmRuntimeConfig } from './common/llm/llm-config';
import { installLlmFetchInterceptor } from './common/llm/llm-fetch-interceptor';
import { Logger, ValidationPipe } from '@nestjs/common';

const repoRoot = join(__dirname, '..', '..', '..');
const apiRoot = join(__dirname, '..');

const envFiles = [
  join(repoRoot, '.env'),
  join(repoRoot, '.env.local'),
  join(apiRoot, '.env'),
  join(apiRoot, '.env.local'),
];

for (const envFile of envFiles) {
  if (!existsSync(envFile)) continue;
  // Deployment-provided environment variables are authoritative. Local files
  // fill gaps only; they must never replace orchestrator secrets or controls.
  loadEnvFile({ path: envFile, override: false });
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // Preserve the existing Ollama-shaped app code while translating OpenAI calls
  // directly at the fetch boundary when LLM_PROVIDER=openai.
  installLlmFetchInterceptor();
  const llm = resolveLlmRuntimeConfig('llama3:latest');
  logger.log(
    `LLM runtime provider=${llm.provider} backend=${llm.url} model=${llm.model}`,
  );

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppModule } = require('./app.module');
  const app = await NestFactory.create(AppModule);

  // ── Global Exception Filter ──────────────────────────────────────────────
  // Catches ALL unhandled errors and converts them to user-friendly messages.
  // Raw stack traces, DB errors, and internal details are NEVER exposed.
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

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
    'http://localhost:3000',
    'http://localhost:3010',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
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
    allowedHeaders:
      'Content-Type,Authorization,x-organization-id,Idempotency-Key',
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
