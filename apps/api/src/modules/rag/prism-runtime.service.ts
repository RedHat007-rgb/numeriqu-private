import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

export type PrismCacheIdentity = {
  organizationId: string;
  capability: string;
  period: string;
  semanticVersion: string;
  sourceWatermark: string;
};

type RuntimeSnapshot = {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  failures: number;
  totalLatencyMs: number;
};

@Injectable()
export class PrismRuntimeService implements OnModuleDestroy {
  private readonly logger = new Logger(PrismRuntimeService.name);
  private readonly redis: Redis | null;
  private readonly local = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private readonly flights = new Map<string, Promise<unknown>>();
  private readonly metrics: RuntimeSnapshot = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    failures: 0,
    totalLatencyMs: 0,
  };

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>('REDIS_URL')?.trim();
    this.redis = redisUrl
      ? new Redis(redisUrl, {
          lazyConnect: true,
          enableReadyCheck: true,
          maxRetriesPerRequest: 1,
        })
      : null;
    this.redis?.on('error', (error) => {
      this.logger.warn(`Prism distributed cache unavailable: ${error.message}`);
    });
  }

  async cached<T>(
    identity: PrismCacheIdentity,
    compute: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    this.metrics.requests += 1;
    const key = this.key(identity);
    try {
      const cached = await this.get(key);
      if (cached !== null) {
        this.metrics.cacheHits += 1;
        return JSON.parse(cached) as T;
      }
      this.metrics.cacheMisses += 1;
      const inFlight = this.flights.get(key) as Promise<T> | undefined;
      if (inFlight) return await inFlight;
      const promise = compute();
      this.flights.set(key, promise);
      try {
        const value = await promise;
        await this.set(key, JSON.stringify(value));
        return value;
      } finally {
        this.flights.delete(key);
      }
    } catch (error) {
      this.metrics.failures += 1;
      throw error;
    } finally {
      this.metrics.totalLatencyMs += Date.now() - started;
    }
  }

  snapshot() {
    const averageLatencyMs = this.metrics.requests
      ? this.metrics.totalLatencyMs / this.metrics.requests
      : 0;
    const availability = this.metrics.requests
      ? (this.metrics.requests - this.metrics.failures) / this.metrics.requests
      : 1;
    const latencyTargetMs = this.positiveInt('PRISM_SLO_AVG_LATENCY_MS', 5_000);
    const availabilityTarget = this.positiveNumber(
      'PRISM_SLO_AVAILABILITY',
      0.995,
    );
    return {
      ...this.metrics,
      averageLatencyMs,
      availability,
      objectives: {
        latencyTargetMs,
        availabilityTarget,
        latencyMet: averageLatencyMs <= latencyTargetMs,
        availabilityMet: availability >= availabilityTarget,
      },
    };
  }

  async onModuleDestroy() {
    if (this.redis?.status === 'ready') await this.redis.quit();
    else this.redis?.disconnect();
  }

  private key(identity: PrismCacheIdentity): string {
    const digest = createHash('sha256')
      .update(JSON.stringify(identity))
      .digest('hex');
    return `prism:answer:${digest}`;
  }

  private ttlSeconds(): number {
    const configured = Number(
      this.config.get<string>('PRISM_CACHE_TTL_SECONDS'),
    );
    return Number.isInteger(configured) && configured > 0 ? configured : 60;
  }

  private async get(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        if (this.redis.status === 'wait') await this.redis.connect();
        return await this.redis.get(key);
      } catch {
        // Local cache preserves correctness and single-flight on one instance.
      }
    }
    const entry = this.local.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.local.delete(key);
      return null;
    }
    return entry.value;
  }

  private async set(key: string, value: string): Promise<void> {
    const ttl = this.ttlSeconds();
    if (this.redis) {
      try {
        if (this.redis.status === 'wait') await this.redis.connect();
        await this.redis.set(key, value, 'EX', ttl);
        return;
      } catch {
        // Fall through to the bounded process-local cache.
      }
    }
    const maxEntries = this.positiveInt('PRISM_LOCAL_CACHE_MAX_ENTRIES', 500);
    if (this.local.size >= maxEntries)
      this.local.delete(this.local.keys().next().value!);
    this.local.set(key, { value, expiresAt: Date.now() + ttl * 1_000 });
  }

  private positiveInt(key: string, fallback: number): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isInteger(configured) && configured > 0
      ? configured
      : fallback;
  }

  private positiveNumber(key: string, fallback: number): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isFinite(configured) && configured > 0
      ? configured
      : fallback;
  }
}
