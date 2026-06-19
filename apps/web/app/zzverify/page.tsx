"use client";
// TEMPORARY verification page — drives the real renderChart with EBPO-shaped data
// to confirm A2 (combo plots all measure-named series) and B (percent formats as %).
import { renderChart } from "../dashboard/_components/DashboardPreview";

const comboChart: any = {
  id: "combo1",
  title: "SLA & CSAT by Delivery Center (combo)",
  type: "combo",
  config: {
    metric: "dynamic",
    grouping: "dynamic",
    display: { valueFormat: "percent", valueDecimals: 1, secondaryAxisFormat: "percent" },
  },
};
const comboData: any[] = [
  { name: "Manila", "SLA Compliance %": 95.2, "CSAT %": 88.1 },
  { name: "Mumbai", "SLA Compliance %": 92.5, "CSAT %": 90.3 },
  { name: "Warsaw", "SLA Compliance %": 97.1, "CSAT %": 85.6 },
  { name: "Dubai", "SLA Compliance %": 90.8, "CSAT %": 92.0 },
];

const pctChart: any = {
  id: "pct1",
  title: "Depreciation % by Delivery Center (percent)",
  type: "bar",
  config: {
    metric: "dynamic",
    grouping: "dynamic",
    display: { valueFormat: "percent", valueDecimals: 1 },
  },
};
const pctData: any[] = [
  { name: "NY HQ", value: 31.8 },
  { name: "LA", value: 29.5 },
  { name: "Dubai", value: 27.5 },
  { name: "Mumbai", value: 26.8 },
];

// ── Series-roles combo cases (the data-2 root fix) ──────────────────────────
// debit + credit as CLUSTERED COLUMNS + net movement as a LINE (all $, one axis).
const debitCreditNet: any = {
  id: "dcn",
  title: "Debit / Credit columns + Net Movement line (by account)",
  type: "combo",
  config: {
    metric: "dynamic",
    grouping: "dynamic",
    display: {
      valueFormat: "currency",
      series: [
        { key: "Total Debit", role: "bar", axis: "left", format: "currency" },
        { key: "Total Credit", role: "bar", axis: "left", format: "currency" },
        { key: "Net Movement", role: "line", axis: "left", format: "currency" },
      ],
    },
  },
};
const debitCreditNetData: any[] = [
  { name: "Accounts Receivable", "Total Debit": 820000, "Total Credit": 510000, "Net Movement": 310000 },
  { name: "Cash", "Total Debit": 640000, "Total Credit": 700000, "Net Movement": -60000 },
  { name: "Inventory", "Total Debit": 430000, "Total Credit": 280000, "Net Movement": 150000 },
  { name: "Payables", "Total Debit": 220000, "Total Credit": 540000, "Net Movement": -320000 },
];

// revenue ($ bar, left) + gross margin % (line, right axis as %).
const revMarginCombo: any = {
  id: "rm",
  title: "Revenue (columns, $) + Gross Margin % (line, right axis %)",
  type: "combo",
  config: {
    metric: "dynamic",
    grouping: "dynamic",
    display: {
      valueFormat: "currency",
      secondaryAxisFormat: "percent",
      series: [
        { key: "Total Revenue", role: "bar", axis: "left", format: "currency" },
        { key: "Gross Margin %", role: "line", axis: "right", format: "percent" },
      ],
    },
  },
};
const revMarginData: any[] = [
  { name: "Jan", "Total Revenue": 11200000, "Gross Margin %": 33.1 },
  { name: "Feb", "Total Revenue": 10800000, "Gross Margin %": 34.2 },
  { name: "Mar", "Total Revenue": 12500000, "Gross Margin %": 32.4 },
  { name: "Apr", "Total Revenue": 11900000, "Gross Margin %": 35.0 },
];

// "line chart showing cash balance and operating cash flow" → TWO LINES (one $ axis).
const twoLineCombo: any = {
  id: "2l",
  title: "Cash Balance + Operating Cash Flow (two lines, one $ axis)",
  type: "combo",
  config: {
    metric: "dynamic",
    grouping: "dynamic",
    display: {
      valueFormat: "currency",
      series: [
        { key: "Cash Balance", role: "line", axis: "left", format: "currency" },
        { key: "Operating Cash Flow", role: "line", axis: "left", format: "currency" },
      ],
    },
  },
};
const twoLineData: any[] = [
  { name: "Jan", "Cash Balance": 4200000, "Operating Cash Flow": 1800000 },
  { name: "Feb", "Cash Balance": 4600000, "Operating Cash Flow": 1500000 },
  { name: "Mar", "Cash Balance": 5100000, "Operating Cash Flow": 2100000 },
  { name: "Apr", "Cash Balance": 4900000, "Operating Cash Flow": 1700000 },
];

// Pareto: single ranked measure; renderer derives the cumulative-% line + 80% marker.
const paretoChart: any = {
  id: "par",
  title: "Departments ranked by total payroll (Pareto)",
  type: "pareto",
  config: { metric: "dynamic", grouping: "dynamic", display: { valueFormat: "currency" } },
};
const paretoData: any[] = [
  { name: "Operations", value: 42000000 },
  { name: "Customer Care", value: 28000000 },
  { name: "IT", value: 19000000 },
  { name: "Finance", value: 12000000 },
  { name: "HR", value: 7000000 },
  { name: "Admin", value: 3990068 },
];

// All-currency clustered columns (type "bar" multi-series) — "show both as bars".
const clusteredBars: any = {
  id: "cb",
  title: "Revenue & Cost by business unit (clustered columns)",
  type: "bar",
  config: { metric: "dynamic", grouping: "dynamic", display: { valueFormat: "currency" } },
};
const clusteredData: any[] = [
  { name: "Telecom", "Total Revenue": 35900000, "Total Cost": 24100000 },
  { name: "IT Helpdesk", "Total Revenue": 25700000, "Total Cost": 17300000 },
  { name: "Banking", "Total Revenue": 23700000, "Total Cost": 15900000 },
  { name: "Healthcare", "Total Revenue": 22800000, "Total Cost": 15600000 },
];

export default function VerifyPage() {
  return (
    <div style={{ padding: 24, background: "#0b0b14" }}>
      <h2 style={{ color: "#fff" }}>A2 — combo (expect BAR + LINE, both series)</h2>
      <div data-testid="combo" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(comboChart, comboData, false)}
      </div>
      <h2 style={{ color: "#fff", marginTop: 32 }}>B — percent (expect % on axis/labels, not $)</h2>
      <div data-testid="pct" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(pctChart, pctData, false)}
      </div>
      <h2 style={{ color: "#fff", marginTop: 32 }}>
        C — debit/credit COLUMNS + net movement LINE (expect 2 bars per account + 1 line)
      </h2>
      <div data-testid="dcn" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(debitCreditNet, debitCreditNetData, false)}
      </div>
      <h2 style={{ color: "#fff", marginTop: 32 }}>
        D — revenue COLUMN ($) + gross margin % LINE on right axis (expect $ left, % right)
      </h2>
      <div data-testid="rm" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(revMarginCombo, revMarginData, false)}
      </div>
      <h2 style={{ color: "#fff", marginTop: 32 }}>
        E — line chart of two $ measures (expect TWO LINES, one $ axis, no bar)
      </h2>
      <div data-testid="2l" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(twoLineCombo, twoLineData, false)}
      </div>
      <h2 style={{ color: "#fff", marginTop: 32 }}>
        F — Pareto (expect ranked bars + cumulative % line + 80% marker)
      </h2>
      <div data-testid="par" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(paretoChart, paretoData, false)}
      </div>
      <h2 style={{ color: "#fff", marginTop: 32 }}>
        G — clustered columns, type=&quot;bar&quot; (expect 2 columns per unit, no line)
      </h2>
      <div data-testid="cb" style={{ width: 700, height: 320, background: "#12121c" }}>
        {renderChart(clusteredBars, clusteredData, false)}
      </div>
    </div>
  );
}
