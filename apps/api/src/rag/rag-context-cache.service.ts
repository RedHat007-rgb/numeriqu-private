import { Injectable, Logger } from '@nestjs/common';
import type { FinancialProfile } from '../financial-data/financial-data.service';

interface CacheEntry {
  profile: FinancialProfile;
  monthlyTrend: any[];
  expiresAt: number;
}

/**
 * RagContextCacheService — Dedicated In-Process Cache for RAG Layer
 *
 * ISOLATION GUARANTEE: This cache is owned exclusively by the RAG module.
 * Agent operations never read from or write to this cache.
 * This prevents the cross-contamination that caused the original RAG failures.
 *
 * TTL: 30s — fresh enough for post-sync accuracy, short enough to prevent stale hallucination.
 */
@Injectable()
export class RagContextCacheService {
  private readonly logger = new Logger(RagContextCacheService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly TTL_MS = 30_000;

  get(tenantId: string): CacheEntry | null {
    const entry = this.cache.get(tenantId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(tenantId);
      this.logger.debug(`[RAG-Cache] EXPIRED for tenant=${tenantId}`);
      return null;
    }
    this.logger.debug(`[RAG-Cache] HIT for tenant=${tenantId}`);
    return entry;
  }

  set(tenantId: string, profile: FinancialProfile, monthlyTrend: any[]): void {
    this.cache.set(tenantId, {
      profile,
      monthlyTrend,
      expiresAt: Date.now() + this.TTL_MS,
    });
    this.logger.debug(
      `[RAG-Cache] SET for tenant=${tenantId} (TTL=${this.TTL_MS}ms)`,
    );
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.logger.log(`[RAG-Cache] INVALIDATED for tenant=${tenantId}`);
  }

  stats(): { entries: number; tenants: string[] } {
    const alive = [...this.cache.entries()].filter(
      ([, v]) => Date.now() <= v.expiresAt,
    );
    return {
      entries: alive.length,
      tenants: alive.map(([k]) => k),
    };
  }
}
