import { chooseEngine, parseRouterConfig } from './engine-router';
import { buildColumnsQuery, inferRelationships, parseSchema, type ColumnRow, type TableRow } from './schema-introspector';

describe('EngineRouter (strangler switch)', () => {
  it('defaults every org to legacy when no orgs are enabled', () => {
    const cfg = parseRouterConfig({});
    expect(chooseEngine('org-1', cfg)).toBe('legacy');
  });

  it('routes only explicitly-enabled orgs to the new engine', () => {
    const cfg = parseRouterConfig({ CHART_ENGINE_NEW_ORGS: 'org-ebpo, org-2' });
    expect(chooseEngine('org-ebpo', cfg)).toBe('new');
    expect(chooseEngine('org-2', cfg)).toBe('new');
    expect(chooseEngine('org-3', cfg)).toBe('legacy');
  });

  it('supports a wildcard for full cutover', () => {
    const cfg = parseRouterConfig({ CHART_ENGINE_NEW_ORGS: '*' });
    expect(chooseEngine('anything', cfg)).toBe('new');
  });
});

describe('SchemaIntrospector parsing', () => {
  it('builds a parameterized columns query (no interpolation)', () => {
    const q = buildColumnsQuery();
    expect(q).toContain('{db:String}');
    expect(q).toContain('{pattern:String}');
    expect(q).toContain('system.columns');
  });

  it('parses column + table rows into a PhysicalSchema', () => {
    const cols: ColumnRow[] = [
      { table: 'v_fact', name: 'client_id', type: 'UInt64', is_nullable: 0 },
      { table: 'v_fact', name: 'revenue_usd', type: 'Decimal(18, 2)', is_nullable: 0 },
      { table: 'v_dim', name: 'client_id', type: 'UInt64', is_nullable: 0 },
      { table: 'v_dim', name: 'client_name', type: 'String', is_nullable: 1 },
    ];
    const rows: TableRow[] = [{ table: 'v_fact', rows: 5000 }, { table: 'v_dim', rows: 50 }];
    const schema = parseSchema('ds1', cols, rows, '2026-07-13T00:00:00Z');
    expect(schema.tables).toHaveLength(2);
    expect(schema.tables.find((t) => t.name === 'v_fact')?.rowCountEstimate).toBe(5000);
    expect(schema.tables.find((t) => t.name === 'v_dim')?.columns.find((c) => c.name === 'client_name')?.nullable).toBe(true);
  });

  it('infers a relationship on a shared *_id key across tables', () => {
    const rels = inferRelationships([
      { name: 'v_fact', rowCountEstimate: 0, columns: [{ name: 'client_id', type: 'UInt64', nullable: false }] },
      { name: 'v_dim', rowCountEstimate: 0, columns: [{ name: 'client_id', type: 'UInt64', nullable: false }] },
    ]);
    expect(rels).toEqual([{ from: 'v_fact', to: 'v_dim', on: 'client_id' }]);
  });
});
