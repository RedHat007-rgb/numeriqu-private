import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismBriefingWorker } from './modules/rag/prism-briefing.worker';

async function bootstrap() {
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const worker = application.get(PrismBriefingWorker);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await worker.run(controller.signal);
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await application.close();
  }
}

void bootstrap();
