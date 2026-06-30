/**
 * Faithful end-to-end question runner (the repeatable version of the manual browser QA).
 *
 * WHY: the old harness (test-ebpo-questions.ts) calls generateSmartPlan DIRECTLY, so it
 * skips the query() generator — i.e. the clarification flow, client resolution, and
 * getDataContext where the real bugs (wrong client universe, false refusals) live. This
 * runner POSTs every question to the REAL /agent/query SSE endpoint exactly like the
 * browser does (full query() path + grounding guard), then reads the resulting dashboard
 * config. It auto-answers the "what time window?" clarification with "Last 12 months".
 *
 * Output: one JSONL row per question (create + follow-up) with type/measures/sql/refusal
 * and auto-flagged issues (GL-demo client leak, refusal, no chart). This is the Phase-3
 * regression gate — re-run after every change.
 *
 * Run:  cd apps/api && npx tsx scripts/ebpo-browser-run.ts [--set qtest-pranjal] [--limit 5]
 */
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true } as any);

const API = process.env.AGENT_API || 'http://127.0.0.1:3000';
const ORG = process.env.HARNESS_ORG_UUID || '7375b5aa-f5bc-4739-88e1-02be1203439b';
const DEMO_EMAIL = 'demo1@numeriqu.com';
const GL_DEMO_CLIENTS = [
  'Apex Ventures',
  'BlueOak',
  'Meridian Retail',
  'TechCorp Solutions',
];

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i === -1 ? undefined : process.argv[i + 1];
};

let COOKIE = '';

async function login(): Promise<void> {
  const res = await fetch(`${API}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL }),
  });
  if (!res.ok) throw new Error(`demo-login failed: ${res.status}`);
  const set = (res.headers as any).getSetCookie?.() ?? [];
  COOKIE = set.map((c: string) => c.split(';')[0]).join('; ');
  if (!COOKIE) throw new Error('no auth cookie from demo-login');
}

type AskResult = { sessionId: string | null; needsInput: boolean; chunks: any[] };

function isTimeWindowClarification(chunks: any[]): boolean {
  const clarify = [...chunks].reverse().find((c) => c?.type === 'clarify');
  if (!clarify) return false;
  const question = String(clarify.question ?? '').toLowerCase();
  const options = Array.isArray(clarify.options) ? clarify.options : [];
  if (
    /\b(time\s+window|time\s+period|date\s+range|which\s+period|which\s+range|last\s+\d+\s+months?|ytd|mtd|qtd)\b/.test(
      question,
    )
  ) {
    return true;
  }
  if (options.length === 0) return false;
  return options.every((opt: any) =>
    /\b(last\s+\d+\s+months?|ytd|mtd|qtd|this\s+year|this\s+month|this\s+quarter|year\s+to\s+date)\b/i.test(
      String(opt?.label ?? '') + ' ' + String(opt?.value ?? ''),
    ),
  );
}

async function ask(query: string, sessionId?: string | null): Promise<AskResult> {
  const res = await fetch(`${API}/agent/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: COOKIE,
      'x-organization-id': ORG,
    },
    body: JSON.stringify({ query, sessionId: sessionId ?? undefined }),
  });
  const text = await res.text();
  const chunks: any[] = [];
  for (const line of text.split('\n')) {
    const t = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!t) continue;
    try {
      chunks.push(JSON.parse(t));
    } catch {
      /* non-JSON keepalive */
    }
  }
  const done = [...chunks].reverse().find((c) => c.type === 'done');
  return {
    sessionId: done?.metrics?.sessionId ?? sessionId ?? null,
    needsInput: !!done?.metrics?.needsInput,
    chunks,
  };
}

async function getChart(sessionId: string): Promise<any | null> {
  const res = await fetch(`${API}/agent/sessions/${sessionId}/dashboard`, {
    headers: { cookie: COOKIE, 'x-organization-id': ORG },
  });
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  return d?.charts?.[0] ?? null;
}

/** Parse the chart type the user explicitly asked for (if any). */
function requestedType(q: string): string | null {
  const s = q.toLowerCase();
  const map: [RegExp, string][] = [
    [/waterfall/, 'waterfall'],
    [/\bbubble\b/, 'bubble'],
    [/\bscatter\b/, 'scatter'],
    [/\bmatrix\b/, 'matrix'],
    [/\b(heat\s?map|heatmap)\b/, 'heatmap'],
    [/\btreemap\b/, 'treemap'],
    [/\bpareto\b/, 'pareto'],
    [/\b(donut|doughnut)\b/, 'donut'],
    [/\bpie\b/, 'pie'],
    [/\bstacked\b/, 'stacked_bar'],
    [/\b(column|bar)\b/, 'bar'],
    [/\b(line|trend)\b/, 'line'],
    [/\barea\b/, 'area'],
    [/\b(kpi|scorecard|card)\b/, 'kpi'],
    [/\bcombo\b/, 'combo'],
  ];
  for (const [re, t] of map) if (re.test(s)) return t;
  return null;
}

/** Loose family match so bar≈stacked_bar≈combo, line≈area, pie≈donut don't false-flag. */
function typeMatches(asked: string, got: string | null): boolean {
  if (!got) return false;
  const fam = (t: string) =>
    /bar|column|combo|stacked/.test(t)
      ? 'bar'
      : /line|area/.test(t)
        ? 'line'
        : /pie|donut/.test(t)
          ? 'pie'
          : t;
  return fam(asked) === fam(got);
}

/** Summarize one chart-config into the fields we compare, + auto-flags. */
function summarize(chart: any, chunks: any[], needsInput = false): any {
  const cfg = chart?.config ?? {};
  const sql = String(cfg.dynamicSql ?? '');
  const streamedText = chunks
    .filter((c) => typeof c?.content === 'string')
    .map((c) => String(c.content))
    .join('');
  const clarify = [...chunks].reverse().find((c) => c?.type === 'clarify');
  const clarifyText = clarify
    ? [
        String(clarify.question ?? '').trim(),
        ...(Array.isArray(clarify.options)
          ? clarify.options
              .map((opt: any) => String(opt?.label ?? '').trim())
              .filter(Boolean)
          : []),
      ]
        .filter(Boolean)
        .join(' | ')
    : '';
  const assistant =
    streamedText ||
    ([...chunks].reverse().find((c) => typeof c.message === 'string')?.message ??
      [...chunks].reverse().find((c) => typeof c.text === 'string')?.text ??
      clarifyText ??
      '');
  const refusalish =
    /can['’]?t|cannot|unavailable|no data|not available|isn['’]?t available|couldn['’]?t|rephrase|there is no|can’t|couldn’t|not supported|unsupported/i;
  const glLeak = GL_DEMO_CLIENTS.filter(
    (n) => sql.includes(n) || String(assistant).includes(n),
  );
  return {
    title: chart?.title ?? null,
    type: chart?.type ?? null,
    measure: cfg.spec?.measure ?? null,
    measures: cfg.spec?.measures ?? null,
    dimension: cfg.spec?.dimension ?? null,
    sql: sql.slice(0, 220),
    assistant: String(assistant).slice(0, 180),
    flags: {
      noChart: !chart,
      refusal: !chart && refusalish.test(String(assistant)),
      needsInput: !!needsInput,
      glClientLeak: glLeak.length ? glLeak : false,
    },
  };
}

async function run() {
  const setName = arg('--set') || 'qtest-pranjal';
  const limit = Number(arg('--limit') || '999');
  const questions = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `${setName}.json`), 'utf8'),
  ).slice(0, limit);

  await login();
  console.log(
    `Running ${questions.length} questions from ${setName} against ${API} (org ${ORG})\n`,
  );

  const outPath = path.resolve(__dirname, `${setName}.browserrun.jsonl`);
  const out = fs.createWriteStream(outPath);
  let issues = 0;

  for (const q of questions) {
    const row: any = { id: q.id, main: q.main, followup: q.followup };
    try {
      // CREATE (auto-answer time-window clarification)
      let r = await ask(q.main);
      const sid = r.sessionId;
      if (r.needsInput && sid && isTimeWindowClarification(r.chunks))
        r = await ask('Last 12 months', sid);
      row.create = sid
        ? summarize(await getChart(sid), r.chunks, r.needsInput)
        : { flags: { noChart: true } };

      // FOLLOW-UP on the same session
      if (sid && q.followup) {
        let rf = await ask(q.followup, sid);
        if (rf.needsInput && isTimeWindowClarification(rf.chunks))
          rf = await ask('Last 12 months', sid);
        row.followup_result = summarize(await getChart(sid), rf.chunks, rf.needsInput);
      }
    } catch (e: any) {
      row.error = String(e?.message ?? e);
    }
    const askedType = requestedType(q.main);
    row.askedType = askedType;
    const typeMismatch =
      askedType && row.create?.type && !typeMatches(askedType, row.create.type)
        ? `TYPE_MISMATCH(asked ${askedType}, got ${row.create.type})`
        : null;
    const f = [
      row.create?.flags?.needsInput && 'CREATE_NEEDS_INPUT',
      row.create?.flags?.refusal && 'CREATE_REFUSED',
      row.create?.flags?.noChart && 'CREATE_NOCHART',
      typeMismatch,
      row.create?.flags?.glClientLeak && `GL_LEAK(${row.create.flags.glClientLeak})`,
      row.followup_result?.flags?.glClientLeak &&
        `FU_GL_LEAK(${row.followup_result.flags.glClientLeak})`,
      row.error && `ERR(${row.error})`,
    ].filter(Boolean);
    if (f.length) issues++;
    console.log(
      `#${String(q.id).padEnd(3)} ${row.create?.type ?? '—'} ${
        f.length ? '⚠ ' + f.join(',') : 'ok'
      }  ${String(q.main).slice(0, 56)}`,
    );
    out.write(JSON.stringify(row) + '\n');
  }
  out.end();
  console.log(`\n${questions.length - issues}/${questions.length} clean. Issues: ${issues}`);
  console.log(`Full results: ${outPath}`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
