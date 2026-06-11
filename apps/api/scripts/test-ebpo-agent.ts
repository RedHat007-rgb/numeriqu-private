/**
 * Faithful agent-layer test for the EBPO org WITHOUT standing up the full server.
 * It uses the REAL production planner system prompt (extracted verbatim from
 * agent.service.ts) + the REAL EBPO introspection context + the configured LLM
 * (OpenAI per LLM_PROVIDER) and then EXECUTES the generated SQL against the live
 * ClickHouse, reporting whether each prompt produced a runnable chart with data.
 *
 * Run: cd apps/api && npx tsx scripts/test-ebpo-agent.ts
 */
import fs from "node:fs";
import path from "node:path";

import { createClient as createClickHouseClient } from "@clickhouse/client";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const TENANT = "7375b5aa-f5bc-4739-88e1-02be1203439b"; // Enterprise BPO Holdings
const EXTERNAL_ORG = "ebpo_enterprise";
const PARAMS = { tenantId: TENANT, externalOrgIds: [EXTERNAL_ORG] };
const ORG_WHERE =
  "tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})";

const PROMPTS = [
  "Avg salary heatmap by department and grade",
  "Revenue YoY growth % by month",
];

const ch = createClickHouseClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER || "dbt_transformer",
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || "",
  database: process.env.CLICKHOUSE_ANALYTICS_DB || "analytics",
});

function extractPlannerPrompt(): string {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/modules/agent/agent.service.ts"),
    "utf8",
  );
  const marker = "const SMART_SQL_PLANNER_SYSTEM = `";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("planner prompt not found");
  const from = start + marker.length;
  const end = src.indexOf("`;", from);
  return src.slice(from, end);
}

async function q(sql: string): Promise<any[]> {
  const r = await ch.query({ query: sql, query_params: PARAMS, format: "JSONEachRow" });
  return (await r.json()) as any[];
}

// Mirrors introspectEbpoSchema() — the live context the planner receives.
async function buildEbpoContext(): Promise<string> {
  const lines: string[] = [];
  const range = (await q(
    `SELECT formatDateTime(min(period_date),'%Y-%m') AS from_d, formatDateTime(max(period_date),'%Y-%m') AS to_d, count() AS n FROM analytics.v_ebpo_revenue_monthly WHERE ${ORG_WHERE}`,
  ))[0];
  const distinct = async (col: string, view: string) =>
    (await q(`SELECT DISTINCT ${col} AS v FROM analytics.${view} WHERE ${ORG_WHERE} AND ${col}!='' ORDER BY v LIMIT 30`)).map((r) => r.v);
  const bus = await distinct("business_unit", "v_ebpo_revenue_by_business_unit");
  const cts = await distinct("contract_type", "v_ebpo_revenue_by_business_unit");
  const depts = await distinct("department", "v_ebpo_payroll_monthly");
  const regions = await distinct("region", "v_ebpo_operations_monthly");
  const buckets = await distinct("aging_bucket", "v_ebpo_ar_aging");
  const clients = await q(`SELECT client_name, round(sum(total_revenue_usd),0) AS rev FROM analytics.v_ebpo_revenue_by_client WHERE ${ORG_WHERE} GROUP BY client_name ORDER BY rev DESC LIMIT 12`);
  lines.push("LIVE DATASET: EBPO Enterprise BPO (use ONLY the v_ebpo_* semantic views below — this org has NO sample_gl_dump / sample_trial_balance / invoice data).");
  lines.push(`• Period coverage: ${range.from_d} → ${range.to_d} (${range.n} monthly rows). Revenue/cost/margin in USD.`);
  lines.push(`• Business units: ${bus.join(", ")}`);
  lines.push(`• Contract types: ${cts.join(", ")}`);
  lines.push(`• Payroll departments: ${depts.join(", ")}`);
  lines.push(`• Regions: ${regions.join(", ")}`);
  lines.push(`• AR/AP aging buckets: ${buckets.join(", ")}`);
  lines.push(`• Top clients by revenue: ${clients.map((c) => `${c.client_name} ($${Math.round(c.rev / 1000)}k)`).join(" | ")}`);
  lines.push(
    "VIEWS (all require: tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})): " +
      "v_ebpo_kpi_monthly(period_date,year,quarter,month,month_name,total_revenue_usd,total_cost_usd,gross_margin_usd,gross_margin_pct,total_payroll_usd,ar_outstanding_usd,ap_outstanding_usd,operating_cash_flow_usd,free_cash_flow_usd,cash_balance_usd,sla_compliance_pct,csat_pct,utilization_pct,dso_days,dpo_days), " +
      "v_ebpo_revenue_monthly(period_date,year,total_revenue_usd,total_cost_usd,gross_margin_usd,gross_margin_pct,revenue_yoy_pct — pre-computed YoY growth %, select directly), " +
      "v_ebpo_revenue_by_client(client_name,industry,total_revenue_usd,total_cost_usd,gross_margin_usd,gross_margin_pct), " +
      "v_ebpo_revenue_by_client_contract(client_name,industry,contract_type,business_unit,total_revenue_usd,total_cost_usd,gross_margin_usd — the ONLY view with both client_name and contract_type; use for revenue by client stacked by contract type), " +
      "v_ebpo_revenue_by_business_unit(business_unit,contract_type,total_revenue_usd,total_cost_usd,gross_margin_usd,gross_margin_pct), " +
      "v_ebpo_payroll_monthly(period_date,department,country,employee_count,total_base_salary_usd,total_overtime_usd,total_bonus_usd,total_benefits_usd,total_payroll_usd), " +
      "v_ebpo_salary_by_dept_grade(department,grade,employee_count,avg_monthly_salary_usd,total_monthly_salary_usd — grades: Associate/Senior Associate/Manager/Director; use for avg salary heatmap by department x grade), " +
      "v_ebpo_gl_monthly(period_date,account_number,account_name,department,business_unit,country,total_debit_usd,total_credit_usd,net_movement_usd), " +
      "v_ebpo_ar_aging(period_date,client_name,industry,aging_bucket,invoice_amount_usd,collected_amount_usd,outstanding_balance_usd,collection_rate_pct), " +
      "v_ebpo_ap_aging(period_date,vendor_name,aging_bucket,invoice_amount_usd,paid_amount_usd,outstanding_balance_usd), " +
      "v_ebpo_operations_monthly(period_date,delivery_center,region,country,market_type,calls_handled,tickets_resolved,avg_aht_minutes,sla_compliance_pct,csat_pct,utilization_pct), " +
      "v_ebpo_cash_flow_monthly(period_date,operating_cash_flow_usd,investing_cash_flow_usd,financing_cash_flow_usd,free_cash_flow_usd,cash_balance_usd). " +
      "Group time series by period_date (already a Date). Output: x/category column AS name, metric AS value (or sumIf pivots for multi-series WIDE).",
  );
  return lines.join("\n");
}

async function callLlm(system: string, user: string): Promise<string> {
  const base = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const body = (await resp.json()) as any;
  return body.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const planner = extractPlannerPrompt();
  const liveContext = await buildEbpoContext();
  console.log("=".repeat(80));
  console.log("EBPO LIVE CONTEXT FED TO PLANNER:\n" + liveContext);
  console.log("=".repeat(80));

  for (const prompt of PROMPTS) {
    console.log("\n\n### PROMPT: " + prompt);
    const userMsg = [
      liveContext,
      `\nUSER REQUEST: "${prompt}"`,
      `First decide the verdict (build / clarify / no_data). Only on "build", generate up to 2 chart(s), each with a precise SQL query using the REAL data values shown above plus accurate xAxisLabel/yAxisLabel. If any named subject is not an exact match to the LIVE DATA above, or the request is ambiguous, return "clarify". If the data genuinely does not exist, return "no_data". Never guess.`,
    ].join("\n");

    let parsed: any;
    try {
      const raw = (await callLlm(planner, userMsg)).replace(/```json|```/g, "").trim();
      parsed = JSON.parse(raw.startsWith("{") ? raw : (raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}"));
    } catch (e: any) {
      console.log("  ❌ LLM/parse error:", e.message);
      continue;
    }

    const verdict = String(parsed.verdict ?? "build").toLowerCase();
    console.log("  verdict:", verdict, "| title:", parsed.title ?? "(none)");
    if (verdict !== "build") {
      console.log("  →", verdict === "clarify" ? JSON.stringify(parsed.clarification)?.slice(0, 200) : parsed.message?.slice(0, 200));
      continue;
    }
    const candidates = parsed.candidates ?? parsed.charts ?? parsed.widgets ?? [];
    for (const c of candidates) {
      const type = c.type ?? c.chartType ?? "?";
      const sql = String(c.sql ?? "").trim();
      const title = c.title ?? "(untitled)";
      const hasScope = /tenant_id\s*=\s*\{tenantId/i.test(sql) && /externalOrgIds/i.test(sql);
      console.log(`  • chart "${title}" [${type}] scoped=${hasScope}`);
      if (!sql) { console.log("    (no sql)"); continue; }
      try {
        const rows = await q(sql.replace(/;+\s*$/, ""));
        const sample = rows.slice(0, 4).map((r) => JSON.stringify(r));
        console.log(`    ✅ ${rows.length} rows | sample: ${sample.join("  ")}`);
      } catch (e: any) {
        console.log(`    ❌ SQL error: ${String(e.message).split("\n")[0]}`);
        console.log(`    SQL: ${sql.slice(0, 240)}`);
      }
    }
  }
  await ch.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
