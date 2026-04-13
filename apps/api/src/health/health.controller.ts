import { Controller, Get, Inject } from '@nestjs/common';
import { CLICKHOUSE_TOKEN, PRISMA_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';
import type { PrismaClient } from '@repo/db';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(CLICKHOUSE_TOKEN) private readonly clickhouse: ClickHouseClient,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {}

  @Get()
  async check() {
    const checks: Record<string, string> = {};

    // Check PostgreSQL (Supabase)
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'unreachable';
    }

    // Check ClickHouse
    try {
      await this.clickhouse.query({ query: 'SELECT 1', format: 'JSON' });
      checks.clickhouse = 'ok';
    } catch {
      checks.clickhouse = 'unreachable';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');

    return {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
