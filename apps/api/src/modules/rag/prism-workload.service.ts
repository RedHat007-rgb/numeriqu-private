import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismWorkloadService {
  private globalActive = 0;
  private readonly organizationActive = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  async withPermit<T>(
    organizationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const globalLimit = this.positiveInt('PRISM_GLOBAL_CONCURRENCY', 64);
    const organizationLimit = this.positiveInt(
      'PRISM_ORGANIZATION_CONCURRENCY',
      4,
    );
    const organizationActive = this.organizationActive.get(organizationId) ?? 0;
    if (
      this.globalActive >= globalLimit ||
      organizationActive >= organizationLimit
    ) {
      throw new ServiceUnavailableException(
        'Prism is at its configured analysis capacity. Please retry shortly.',
      );
    }
    this.globalActive += 1;
    this.organizationActive.set(organizationId, organizationActive + 1);
    try {
      return await work();
    } finally {
      this.globalActive -= 1;
      const next = (this.organizationActive.get(organizationId) ?? 1) - 1;
      if (next <= 0) this.organizationActive.delete(organizationId);
      else this.organizationActive.set(organizationId, next);
    }
  }

  snapshot() {
    return {
      globalActive: this.globalActive,
      activeOrganizations: this.organizationActive.size,
    };
  }

  private positiveInt(key: string, fallback: number): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isInteger(configured) && configured > 0
      ? configured
      : fallback;
  }
}
