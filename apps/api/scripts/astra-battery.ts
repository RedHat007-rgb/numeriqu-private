/**
 * Astra battery runner — exercises EVERY test question (main + follow-up) through
 * the live agent engine for numeriqu-demo and records the produced chart spec so
 * we can audit correctness at scale instead of clicking 144 charts by hand.
 *
 * Talks to the running API (:3000) directly: demo-login once, then POST
 * /agent/query per question (main, then follow-up with the new sessionId), and
 * read back the built dashboard. Writes one JSON line per query to
 * scripts/astra-results.jsonl (incremental, resumable to eyeball live).
 *
 * Run (API must be up):  cd apps/api && npx tsx scripts/astra-battery.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const API = process.env.BATTERY_API || 'http://127.0.0.1:3000';
const ORG =
  process.env.BATTERY_ORG || '4d1aa04c-0983-4f6a-8705-fe9c10b27c62';
const EMAIL = process.env.BATTERY_EMAIL || 'demo3@numeriqu.com';
const ALL_QUESTIONS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'astra-questions.json'), 'utf8'),
) as Array<{
  no: string;
  category: string;
  main: string;
  followup: string | null;
}>;
const START = Math.max(0, Number(process.env.BATTERY_START || '0'));
const LIMIT = Math.max(1, Number(process.env.BATTERY_LIMIT || '999'));
const requestedNumbers = new Set(
  String(process.env.BATTERY_NUMBERS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const QUESTIONS = requestedNumbers.size
  ? ALL_QUESTIONS.filter((question) =>
      requestedNumbers.has(String(Number(question.no))),
    )
  : ALL_QUESTIONS.slice(START, START + LIMIT);
const OUT = process.env.BATTERY_OUT
  ? path.resolve(process.env.BATTERY_OUT)
  : path.resolve(__dirname, 'astra-results.jsonl');

let COOKIE = '';

async function api(
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = 150000,
): Promise<{ status: number; json: any; raw: string; setCookie: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-organization-id': ORG,
        ...(COOKIE ? { Cookie: COOKIE } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const setCookie = (res.headers as any).getSetCookie?.() ?? [];
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text.slice(0, 200) };
    }
    return { status: res.status, json, raw: text, setCookie };
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const r = await api('POST', '/auth/demo-login', { email: EMAIL });
  if (r.setCookie.length)
    COOKIE = r.setCookie.map((c) => c.split(';')[0]).join('; ');
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
  console.log(
    `logged in as ${EMAIL}; cookie ${COOKIE ? 'captured' : 'MISSING'}`,
  );
}

function parseSse(raw: string): any[] {
  return raw
    .split('\n')
    .map((line) => (line.startsWith('data:') ? line.slice(5).trim() : ''))
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Pull the salient fields from the freshly-built dashboard for auditing. */
function summarizeDashboard(j: any) {
  const c = j?.charts?.[0];
  const cfg = c?.config ?? {};
  const spec = cfg.spec ?? {};
  return {
    dashTitle: j?.title,
    chartType: c?.type,
    measureKeys: spec.measureKeys,
    dimensionKey: spec.dimensionKey ?? null,
    breakdownKey: spec.breakdownKey ?? null,
    timeGrain: spec.timeGrain ?? null,
    valueFormat: cfg.display?.valueFormat,
    seriesFormats: (cfg.display?.series ?? []).map(
      (s: any) => `${s.key}:${s.format}`,
    ),
    routedView: cfg.routedView,
    sql: (cfg.dynamicSql ?? '').replace(/\s+/g, ' ').slice(0, 220),
  };
}

async function runQuery(query: string, sessionId?: string) {
  const t0 = Date.now();
  let r = await api(
    'POST',
    '/agent/query',
    sessionId ? { query, sessionId } : { query },
  );
  if (r.status === 401) {
    await login();
    r = await api(
      'POST',
      '/agent/query',
      sessionId ? { query, sessionId } : { query },
    );
  }
  const ms = Date.now() - t0;
  const chunks = parseSse(r.raw);
  const done = [...chunks].reverse().find((chunk) => chunk?.type === 'done');
  const resolvedSessionId =
    done?.metrics?.sessionId ?? sessionId ?? undefined;
  const clarification = [...chunks]
    .reverse()
    .find((chunk) => chunk?.type === 'clarify');
  let dash = resolvedSessionId
    ? await api('GET', `/agent/sessions/${resolvedSessionId}/dashboard`)
    : null;
  if (dash?.status === 401 && resolvedSessionId) {
    await login();
    dash = await api(
      'GET',
      `/agent/sessions/${resolvedSessionId}/dashboard`,
    );
  }
  return {
    status: r.status,
    ms,
    sessionId: resolvedSessionId,
    needsInput: Boolean(done?.metrics?.needsInput),
    summary:
      clarification
        ? {
            clarification: clarification.question,
            options: clarification.options,
          }
        : (r.status === 201 || r.status === 200) && dash?.status === 200
          ? summarizeDashboard(dash.json)
        : { error: r.json },
  };
}

async function main() {
  fs.writeFileSync(OUT, ''); // fresh
  await login();
  let n = 0;
  for (const q of QUESTIONS) {
    n++;
    try {
      const mainRes = await runQuery(q.main);
      const sid = mainRes.sessionId;
      let fu: any = null;
      if (q.followup && sid) fu = await runQuery(q.followup, sid);
      const rec = {
        no: q.no,
        category: q.category,
        main: q.main,
        mainResult: mainRes,
        followup: q.followup,
        followupResult: fu,
        sessionId: sid,
      };
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      console.log(
        `[${n}/${QUESTIONS.length}] Q${q.no} main=${mainRes.status}(${mainRes.ms}ms) fu=${fu ? fu.status : '-'} | ${(mainRes.summary as any).measureKeys?.join(',') ?? (mainRes.summary as any).error ?? '?'}`,
      );
    } catch (e) {
      const rec = { no: q.no, main: q.main, error: (e as Error).message };
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      console.log(
        `[${n}/${QUESTIONS.length}] Q${q.no} ERROR ${(e as Error).message}`,
      );
    }
  }
  console.log(`\nDONE. Results in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
