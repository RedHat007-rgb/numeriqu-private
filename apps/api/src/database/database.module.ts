import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createClient as createCHClient } from '@clickhouse/client';
import { prisma } from '@repo/db';

export const CLICKHOUSE_TOKEN = 'ClickHouseClient';
export const CLICKHOUSE_QUICKBOOKS_TOKEN = 'ClickHouseQuickBooksClient';
export const CLICKHOUSE_XERO_TOKEN = 'ClickHouseXeroClient';
export const CLICKHOUSE_ANALYTICS_TOKEN = 'ClickHouseAnalyticsClient';
export const PRISMA_TOKEN = 'PrismaClient';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: CLICKHOUSE_TOKEN,
      useFactory: (config: ConfigService) => {
        return createCHClient({
          url: config.getOrThrow<string>('CLICKHOUSE_URL'),
          username: config.get<string>('CLICKHOUSE_USER') || 'default',
          password: config.get<string>('CLICKHOUSE_PASSWORD') || '',
        });
      },
      inject: [ConfigService],
    },
    {
      provide: CLICKHOUSE_QUICKBOOKS_TOKEN,
      useFactory: (config: ConfigService) => {
        return createCHClient({
          url:
            config.get<string>('CLICKHOUSE_QUICKBOOKS_URL') ||
            config.getOrThrow<string>('CLICKHOUSE_URL'),
          username:
            config.get<string>('CLICKHOUSE_QUICKBOOKS_USER') ||
            config.get<string>('CLICKHOUSE_USER') ||
            'default',
          password:
            config.get<string>('CLICKHOUSE_QUICKBOOKS_PASSWORD') ||
            config.get<string>('CLICKHOUSE_PASSWORD') ||
            '',
        });
      },
      inject: [ConfigService],
    },
    {
      provide: CLICKHOUSE_XERO_TOKEN,
      useFactory: (config: ConfigService) => {
        return createCHClient({
          url:
            config.get<string>('CLICKHOUSE_XERO_URL') ||
            config.getOrThrow<string>('CLICKHOUSE_URL'),
          username:
            config.get<string>('CLICKHOUSE_XERO_USER') ||
            config.get<string>('CLICKHOUSE_USER') ||
            'default',
          password:
            config.get<string>('CLICKHOUSE_XERO_PASSWORD') ||
            config.get<string>('CLICKHOUSE_PASSWORD') ||
            '',
        });
      },
      inject: [ConfigService],
    },
    {
      provide: CLICKHOUSE_ANALYTICS_TOKEN,
      useFactory: (config: ConfigService) => {
        return createCHClient({
          url:
            config.get<string>('CLICKHOUSE_ANALYTICS_URL') ||
            config.getOrThrow<string>('CLICKHOUSE_URL'),
          username:
            config.get<string>('CLICKHOUSE_ANALYTICS_USER') ||
            'dbt_transformer',
          password:
            config.get<string>('CLICKHOUSE_ANALYTICS_PASSWORD') ||
            'dbt_pass_123',
          database:
            config.get<string>('CLICKHOUSE_ANALYTICS_DB') || 'analytics',
        });
      },
      inject: [ConfigService],
    },
    {
      provide: PRISMA_TOKEN,
      useFactory: async () => {
        try {
          await prisma.$connect();
          return prisma;
        } catch (e: any) {
          console.error(`[Prisma] Critical Connection Failure: ${e.message}`);
          throw e; // Fail-fast on startup
        }
      },
    },
  ],
  exports: [
    CLICKHOUSE_TOKEN,
    CLICKHOUSE_QUICKBOOKS_TOKEN,
    CLICKHOUSE_XERO_TOKEN,
    CLICKHOUSE_ANALYTICS_TOKEN,
    PRISMA_TOKEN,
  ],
})
export class DatabaseModule {}
