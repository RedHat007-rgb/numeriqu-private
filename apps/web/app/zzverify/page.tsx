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
    </div>
  );
}
