/**
 * Cube materializer — the data-driven onboarding path (Phase C1, option A).
 *
 * Turns a set of declarative `CubeBlueprint`s into live ClickHouse views for a
 * brand-new dataset with ZERO per-dataset TypeScript:
 *   1. skip blueprints whose fact table isn't actually loaded (no fake cubes),
 *   2. fill any `discover: true` pivot with the taxonomy read live from the data
 *      (SELECT DISTINCT) — so the blueprint never hardcodes category values,
 *   3. build each view with the generic `buildCubeViewDdl` and run it,
 *   4. return the created view names so the caller registers them on the Dataset.
 *
 * The blueprints themselves are DATA (derivable from the mapping workbook), so
 * onboarding a new client shape is "load data + provide blueprints + run" — no
 * code change, no redeploy. Existing bespoke datasets are untouched.
 */

import { buildCubeViewDdl, type CubeBlueprint } from './cube-builder';

/** The minimal ClickHouse surface the materializer needs (keeps it testable). */
export interface CubeMaterializerClient {
  /** Return distinct non-empty string values of a column in a table. */
  distinct(table: string, column: string): Promise<string[]>;
  /** Whether a table/view exists in the target database. */
  tableExists(name: string): Promise<boolean>;
  /** Execute a DDL statement (CREATE OR REPLACE VIEW …). */
  exec(ddl: string): Promise<void>;
}

export interface MaterializeResult {
  created: string[];
  skipped: Array<{ view: string; reason: string }>;
}

/**
 * Resolve `discover` pivots against the live data, then materialize each
 * blueprint whose fact table exists. Deterministic given the same data.
 */
export async function materializeCubes(
  database: string,
  blueprints: CubeBlueprint[],
  client: CubeMaterializerClient,
): Promise<MaterializeResult> {
  const created: string[] = [];
  const skipped: Array<{ view: string; reason: string }> = [];

  for (const bp of blueprints) {
    if (!(await client.tableExists(bp.factTable))) {
      skipped.push({ view: bp.view, reason: `fact table not loaded: ${bp.factTable}` });
      continue;
    }
    // Skip a join whose dim isn't present rather than emitting broken SQL.
    const joins = [] as NonNullable<CubeBlueprint['joins']>;
    for (const j of bp.joins ?? []) {
      if (await client.tableExists(j.dimTable)) joins.push(j);
      else skipped.push({ view: bp.view, reason: `dim not loaded, join dropped: ${j.dimTable}` });
    }

    // Fill discover-pivots with live taxonomy; drop pivots that resolve to empty.
    const pivots = [] as NonNullable<CubeBlueprint['pivots']>;
    for (const p of bp.pivots ?? []) {
      const values = p.discover ? await client.distinct(bp.factTable, p.categoryColumn) : p.values ?? [];
      if (values.length) pivots.push({ ...p, values, discover: false });
      else if (!p.discover) pivots.push({ ...p, values });
    }

    const resolved: CubeBlueprint = { ...bp, joins, pivots };
    try {
      await client.exec(buildCubeViewDdl(database, resolved));
      created.push(bp.view);
    } catch (e) {
      skipped.push({ view: bp.view, reason: (e as Error).message.split('\n')[0] });
    }
  }

  return { created, skipped };
}
