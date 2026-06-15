import { toPng, toSvg, toBlob } from "html-to-image";

/** Build a safe, readable file name from dashboard + chart titles. */
export function chartFilename(parts: Array<string | undefined>, ext: string): string {
  const base = parts
    .filter(Boolean)
    .join(" - ")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120) || "chart";
  return `${base}.${ext}`;
}

/** Resolve the themed card background so exported images aren't transparent. */
function cardBackground(): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-bg-card")
      .trim();
    if (v) return `rgb(${v})`;
  } catch {
    /* noop */
  }
  return "#ffffff";
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pngOpts = () => ({
  pixelRatio: 2,
  cacheBust: true,
  backgroundColor: cardBackground(),
  // The card itself can be a click target / have hover affordances we don't
  // want baked into the export.
  filter: (node: HTMLElement) =>
    !(node instanceof HTMLElement && node.dataset?.exportIgnore === "true"),
});

export async function exportChartPng(node: HTMLElement, filename: string) {
  const url = await toPng(node, pngOpts());
  triggerDownload(url, filename);
}

export async function exportChartSvg(node: HTMLElement, filename: string) {
  const url = await toSvg(node, {
    cacheBust: true,
    backgroundColor: cardBackground(),
  });
  triggerDownload(url, filename);
}

/** Copy the chart to the clipboard as a PNG image (for pasting into Slack/docs). */
export async function copyChartImage(node: HTMLElement): Promise<boolean> {
  const blob = await toBlob(node, pngOpts());
  if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return false;
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  return true;
}

/** Export an entire dashboard (every rendered chart) into one paginated PDF. */
export async function exportDashboardPdf(
  dashboardTitle: string,
  charts: Array<{ id: string; title: string }>,
): Promise<number> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;
  let exported = 0;
  let first = true;

  for (const c of charts) {
    const node = document.getElementById(`chart-canvas-${c.id}`);
    if (!node) continue;
    let dataUrl: string;
    try {
      dataUrl = await toPng(node as HTMLElement, pngOpts());
    } catch {
      continue;
    }
    const img = new Image();
    await new Promise<void>((res) => {
      img.onload = () => res();
      img.onerror = () => res();
      img.src = dataUrl;
    });
    if (!img.width || !img.height) continue;

    if (!first) pdf.addPage();
    first = false;

    pdf.setFontSize(14);
    pdf.setTextColor(20, 20, 30);
    pdf.text(c.title || "Chart", margin, margin);

    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2 - 24;
    const ratio = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * ratio;
    const h = img.height * ratio;
    pdf.addImage(dataUrl, "PNG", margin, margin + 16, w, h, undefined, "FAST");
    exported += 1;
  }

  if (exported === 0) return 0;
  pdf.save(chartFilename([dashboardTitle, "dashboard"], "pdf"));
  return exported;
}

/** Serialize an array of row objects to CSV (handles quoting/escaping). */
export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const keys = Array.from(
    rows.reduce<Set<string>>((set, r) => {
      Object.keys(r ?? {}).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  );
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = keys.join(",");
  const body = rows.map((r) => keys.map((k) => esc((r as any)[k])).join(",")).join("\n");
  return `${header}\n${body}`;
}

export function exportChartCsv(rows: Array<Record<string, unknown>>, filename: string) {
  downloadBlob(rowsToCsv(rows), filename, "text/csv;charset=utf-8");
}

/** One CSV file for a whole dashboard, sectioned per chart. */
export function exportDashboardCsv(
  dashboardTitle: string,
  charts: Array<{ title: string; rows: Array<Record<string, unknown>> }>,
) {
  const blocks = charts
    .filter((c) => c.rows && c.rows.length > 0)
    .map((c) => `# ${c.title}\n${rowsToCsv(c.rows)}`);
  if (blocks.length === 0) return;
  downloadBlob(
    blocks.join("\n\n"),
    chartFilename([dashboardTitle, "all data"], "csv"),
    "text/csv;charset=utf-8",
  );
}
