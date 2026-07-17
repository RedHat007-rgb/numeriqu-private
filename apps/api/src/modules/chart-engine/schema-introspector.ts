/**
 * SchemaIntrospector — discovers a client's physical schema from ClickHouse
 * system tables. See docs/TARGET_ARCHITECTURE.md §4①.
 *
 * This file holds the PURE, testable parts: the SQL we run and the parsing of
 * its results into a PhysicalSchema, plus relationship inference. The live query
 * execution belongs in a thin NestJS service that hands raw rows to `parseSchema`.
 * Nothing here assumes a specific client — it discovers, it never hardcodes.
 */

import type { PhysicalSchema, PhysicalTable } from './semantic-model.types';

/** Row shape returned by the columns query. */
export interface ColumnRow {
  table: string;
  name: string;
  type: string;
  is_nullable: number | boolean;
}

/** Row shape returned by the table row-count query. */
export interface TableRow {
  table: string;
  rows: number;
}

/**
 * SQL to enumerate columns for a database. `tablePattern` optionally restricts
 * to views/tables of interest (e.g. materialized semantic views). Parameterized
 * on the database name; the pattern is a LIKE against the table name.
 */
export function buildColumnsQuery(): string {
  return (
    `SELECT table, name, type, ` +
    `position(lower(type), 'nullable') > 0 AS is_nullable ` +
    `FROM system.columns ` +
    `WHERE database = {db:String} ` +
    `AND (table LIKE {pattern:String}) ` +
    `ORDER BY table, position`
  );
}

/** SQL to estimate row counts per table. */
export function buildTableRowsQuery(): string {
  return (
    `SELECT table, sum(rows) AS rows ` +
    `FROM system.parts ` +
    `WHERE database = {db:String} AND active ` +
    `GROUP BY table`
  );
}

/**
 * SQL to gather per-column statistics for profiling. Deterministic string; the
 * caller binds {db}, and table/column are validated identifiers interpolated by
 * the caller from introspected names (never user text).
 */
export function buildColumnStatsQuery(db: string, table: string, column: string, numeric: boolean): string {
  assertIdent(db);
  assertIdent(table);
  assertIdent(column);
  const numericAggs = numeric
    ? `, min(${column}) AS min_v, max(${column}) AS max_v`
    : `, NULL AS min_v, NULL AS max_v`;
  return (
    `SELECT count() AS row_count, ` +
    `uniqExact(${column}) AS distinct_count, ` +
    `countIf(${column} IS NULL) / greatest(count(), 1) AS null_fraction` +
    numericAggs + `, ` +
    `arraySlice(groupUniqArray(10)(toString(${column})), 1, 10) AS samples ` +
    `FROM ${db}.${table}`
  );
}

function assertIdent(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${JSON.stringify(name)}`);
  }
}

/** Infer shared-key relationships: an `x_id`/`x_key` column present in ≥2 tables. */
export function inferRelationships(tables: PhysicalTable[]): PhysicalSchema['relationships'] {
  const keyToTables = new Map<string, string[]>();
  for (const t of tables) {
    for (const c of t.columns) {
      if (/(_id|_key)$/i.test(c.name)) {
        const arr = keyToTables.get(c.name) ?? [];
        arr.push(t.name);
        keyToTables.set(c.name, arr);
      }
    }
  }
  const rels: PhysicalSchema['relationships'] = [];
  for (const [key, ts] of keyToTables) {
    if (ts.length < 2) continue;
    // Pair the first table with each other on the shared key.
    for (let i = 1; i < ts.length; i++) {
      rels.push({ from: ts[0]!, to: ts[i]!, on: key });
    }
  }
  return rels;
}

/** Parse raw column + table rows into a PhysicalSchema. Pure. */
export function parseSchema(
  datasetId: string,
  columnRows: ColumnRow[],
  tableRows: TableRow[],
  introspectedAt: string,
): PhysicalSchema {
  const rowsByTable = new Map(tableRows.map((r) => [r.table, Number(r.rows) || 0]));
  const tableMap = new Map<string, PhysicalTable>();
  for (const r of columnRows) {
    let t = tableMap.get(r.table);
    if (!t) {
      t = { name: r.table, columns: [], rowCountEstimate: rowsByTable.get(r.table) ?? 0 };
      tableMap.set(r.table, t);
    }
    t.columns.push({ name: r.name, type: r.type, nullable: Boolean(r.is_nullable) });
  }
  const tables = [...tableMap.values()];
  return { datasetId, tables, relationships: inferRelationships(tables), introspectedAt };
}
