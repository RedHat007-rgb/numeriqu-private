/**
 * EngineRouter — the strangler-fig switch. Decides, per organization, whether a
 * chart request is served by the NEW autonomous chart engine or the LEGACY
 * agent.service path. See docs/TARGET_ARCHITECTURE.md §6.
 *
 * DEFAULT IS LEGACY. The new engine is opt-in per org via env/flag so we can
 * turn EBPO on first (gated by the DAX oracle) and roll forward safely. Until an
 * org is explicitly enabled, behaviour is identical to today.
 */

export type EngineChoice = 'new' | 'legacy';

export interface RouterConfig {
  /**
   * Comma-separated org ids (or the literal "*") allowed on the new engine.
   * Sourced from env CHART_ENGINE_NEW_ORGS. Empty ⇒ everyone stays on legacy.
   */
  newEngineOrgs: string;
}

export function parseRouterConfig(env: Record<string, string | undefined>): RouterConfig {
  return { newEngineOrgs: (env.CHART_ENGINE_NEW_ORGS ?? '').trim() };
}

/** Pure routing decision. */
export function chooseEngine(organizationId: string, config: RouterConfig): EngineChoice {
  const raw = config.newEngineOrgs;
  if (!raw) return 'legacy';
  const allow = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.includes('*')) return 'new';
  return allow.includes(organizationId) ? 'new' : 'legacy';
}

/** Telemetry payload emitted for every request so we can track migration %. */
export interface EngineDecisionLog {
  organizationId: string;
  engine: EngineChoice;
  at: string; // ISO, stamped by caller
}
