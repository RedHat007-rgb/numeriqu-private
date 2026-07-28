/**
 * KPI card glossary flip — parity with the overview page.
 * ---------------------------------------------------------------------------
 * Ports the tap-to-flip behaviour of `MetricTile` + `GlossaryBackFace`
 * (apps/web/app/dashboard/_pages/OverviewPage.tsx,
 *  apps/web/app/dashboard/_components/overview/GlossaryBackFace.tsx)
 * onto this dashboard's static `.kpi-card` markup.
 *
 * The overview resolves a definition from a card *id*; this dashboard has no
 * ids, so cards are keyed by their `.kpi-label` text using the same
 * punctuation-insensitive normalisation as apps/web/app/dashboard/_lib/glossary.ts.
 *
 * This file is a pure enhancement: it wraps `afterDashboardRenderEnhanced()`
 * (called by `render()` on every page/date change) and touches nothing else in
 * index.html. If it fails to load, the dashboard renders exactly as before.
 */
(function () {
  "use strict";

  /* ===========================================================================
   * 1. Glossary content
   * ---------------------------------------------------------------------------
   * SHEET_ENTRIES is a verbatim port of GLOSSARY_ENTRIES in
   * apps/web/app/dashboard/_lib/glossary.ts — source of truth is
   * "Reference Sheet for Demo.xlsx" → Glossary sub-sheet. Do not reword these;
   * keep them in sync with the .ts file so both dashboards read identically.
   * ========================================================================= */
  const SHEET_ENTRIES = [
    { term: "Revenue", definition: "Total income earned from BPO services such as customer support, back-office processing, finance & accounting, healthcare, and other outsourced operations." },
    { term: "Margin Quality", definition: "Profits over Revenue." },
    { term: "Gross Margin", definition: "Gross profit as a percentage of revenue (gross profit ÷ revenue). Gross profit is revenue remaining after direct delivery costs." },
    { term: "Net Contribution", definition: "Net Profit: revenue remaining after direct delivery costs that contributes toward covering overheads and generating profit." },
    { term: "Open Invoices", definition: "Customer invoices that have been issued but are still awaiting payment." },
    { term: "Cash Runway", definition: "Estimated number of months/days the BPO can continue operating using its available cash if current spending continues." },
    { term: "Monthly Operating Load", definition: "Average monthly operating expenses required to run delivery centers, payroll, facilities, technology, and administration." },
    { term: "Working Capital", definition: "Funds available to manage day-to-day BPO operations after covering short-term obligations." },
    { term: "Cash Balance", definition: "Total cash available in company bank accounts for business operations." },
    { term: "Collection Risk", definition: "Risk that clients may delay paying invoices, affecting the company's cash flow." },
    { term: "Live Finance Stream", definition: "Real-time financial data continuously updating from connected accounting systems." },
    { term: "Treasury", definition: "Management of company cash, liquidity, banking, and funding needed to operate the business." },
    { term: "Collections", definition: "Process of collecting payments from clients for completed BPO services." },
    { term: "Concentration", definition: "Level of dependence on a small number of clients for revenue. Higher concentration means higher business risk." },
    { term: "Expand Coverage", definition: "Recommendation to connect additional financial or operational data sources for broader reporting." },
    { term: "Receivables Open", definition: "Total unpaid customer invoices that are yet to be collected." },
    { term: "Past Due Now", definition: "Outstanding invoices that have crossed their payment due date." },
    { term: "Margin Discipline", definition: "Ability of the BPO to consistently maintain healthy profit margins by controlling delivery costs." },
    { term: "Payroll / Revenue", definition: "Percentage of total revenue spent on employee salaries and wages. Since payroll is the largest BPO expense, this measures workforce cost efficiency." },
    { term: "Free Cash Flow", definition: "Cash remaining after paying operating expenses and capital investments. Available for growth, debt repayment, or reserves." },
    { term: "Operating Cash Flow", definition: "Cash generated from normal BPO operations such as providing outsourced services and collecting customer payments." },
    { term: "DSO / DPO Spread", definition: "Difference between how quickly the company collects money from clients (DSO) and how quickly it pays suppliers (DPO)." },
    { term: "DSO (Days Sales Outstanding)", definition: "Average number of days clients take to pay invoices. Lower DSO improves cash flow." },
    { term: "DPO (Days Payable Outstanding)", definition: "Average number of days the company takes to pay vendors and suppliers." },
    { term: "Spend", definition: "Total operating expenses incurred by the business." },
    { term: "Payroll Elements", definition: "Total payroll split into its components — base salary, overtime, bonus, and benefits." },
    { term: "Overdue Exposure", definition: "Total value of overdue customer invoices that have not been collected." },
    { term: "Receivables Exposure", definition: "Financial risk created by outstanding customer payments." },
    { term: "Receivables Exposure – Open Balance", definition: "Total invoice value currently awaiting payment from clients." },
    { term: "Open Balance", definition: "Total unpaid invoice amount." },
    { term: "Aging", definition: "Classification of unpaid invoices based on how long they have remained outstanding (e.g., 0–30, 31–60, 61–90 days)." },
    { term: "Concentration Risk", definition: "Risk arising when a large percentage of revenue depends on one or a few clients." },
    { term: "Largest Account", definition: "Client generating the highest revenue for the company." },
    { term: "Revenue Share", definition: "Percentage of total company revenue contributed by a client, service line, or business unit." },
    { term: "Best Margin Unit", definition: "Business unit delivering the highest profit margin compared to others." },
    { term: "Delivery Pulse", definition: "Operational health summary of service delivery performance." },
    { term: "SLA Compliance", definition: "Percentage of customer service commitments delivered within agreed Service Level Agreements." },
    { term: "Service Miss Rate", definition: "Percentage of service commitments that failed to meet agreed SLA targets." },
    { term: "Credits", definition: "Financial adjustments or service credits issued to clients because of SLA failures or billing corrections." },
    { term: "Churn Risk", definition: "Risk that a client may reduce or terminate its outsourcing contract." },
    { term: "Utilization", definition: "Percentage of employee working time spent on productive client work versus available capacity." },
    { term: "Operational Strain", definition: "Delivery issues that reduce operational efficiency or profitability." },
    { term: "CSAT", definition: "Customer Satisfaction Score measuring how satisfied clients or end customers are with the delivered service." },
    { term: "Entities Live", definition: "Number of legal entities or companies currently connected to the platform." },
    { term: "Revenue Covered", definition: "Total revenue included within connected and validated data sources." },
    { term: "Signal State", definition: "Status showing whether financial data is currently being received successfully." },
    { term: "Live", definition: "Indicates connected systems are actively sending current data." },
    { term: "Manage Integrations", definition: "Connect or manage ERP, accounting, payroll, CRM, and operational systems used by the business." },
    { term: "Sample Company", definition: "Example business whose financial data is displayed in the dashboard." },
    { term: "Invoices", definition: "Bills issued to clients for completed BPO services." },
    { term: "Top Exposure", definition: "Highest financial risk currently affecting the company, such as a large overdue client balance or major revenue dependency." },
    { term: "Cash Position", definition: "Overall liquidity available after considering all cash inflows and outflows." },
    { term: "Capital", definition: "Financial resources available to operate and grow the BPO business." },
    { term: "Margin", definition: "Profit earned after deducting service delivery costs from revenue." },
    { term: "Exposure", definition: "Financial or operational risk that could negatively impact business performance." },
  ];

  /* ---------------------------------------------------------------------------
   * NOT FROM THE REFERENCE SHEET.
   *
   * This dashboard surfaces ~25 metrics the overview page does not (EBITDA,
   * CAGR, the balance-sheet ratios, the per-FTE productivity set). The Glossary
   * sub-sheet has no wording for them, so these are written here in the same
   * plain-English BPO register. They are business-facing copy that has NOT been
   * signed off — get them reviewed, then fold any approved wording back into
   * the sheet and into _lib/glossary.ts so the two dashboards stay identical.
   * ------------------------------------------------------------------------- */
  const EXTENDED_ENTRIES = [
    { term: "Revenue CAGR", definition: "Compound annual growth rate of revenue — the steady yearly growth rate that would take revenue from the first year in scope to the last." },
    { term: "EBITDA", definition: "Earnings before interest, tax, depreciation and amortisation. Operating profitability of the BPO before financing and accounting charges." },
    { term: "EBITDA Margin", definition: "EBITDA as a percentage of revenue. Shows how much of every revenue dollar survives delivery and overhead costs." },
    { term: "Gross Profit", definition: "Revenue remaining after the direct cost of delivering services (agent payroll, delivery centers, service-specific costs)." },
    { term: "Operating Profit", definition: "Profit left after both direct delivery costs and operating overheads such as SG&A, before finance costs and tax." },
    { term: "Cost of Service", definition: "Direct cost of delivering client work — the payroll, facilities and technology consumed by service delivery itself." },
    { term: "SG&A", definition: "Selling, general and administrative expenses — the overheads that support the business but are not tied to delivering a specific client contract." },
    { term: "Effective Tax Rate", definition: "Tax charge as a percentage of pre-tax profit. Shows the real tax burden actually borne by the business." },
    { term: "Collection Rate", definition: "Share of invoiced revenue that has actually been collected in cash. A low rate means revenue is booked but the cash has not arrived." },
    { term: "Client Invoiced", definition: "Total value billed to clients for delivered services in the selected period." },
    { term: "Cash Collected", definition: "Total cash actually received from clients against issued invoices in the selected period." },
    { term: "AR Outstanding", definition: "Accounts receivable still open — invoiced amounts not yet paid by clients." },
    { term: "Overdue AR", definition: "Receivables that have passed their due date and are now at risk of becoming a collection problem." },
    { term: "AP Outstanding", definition: "Accounts payable still open — amounts invoiced by vendors and suppliers that the company has not yet paid." },
    { term: "AR less AP", definition: "Open receivables minus open payables. A positive figure means more cash is owed to the business than by it." },
    { term: "Total Payroll", definition: "Full cost of the workforce for the period — base salary, overtime, bonus and benefits combined." },
    { term: "Closing Cash", definition: "Cash held at the end of the selected period, after all operating, investing and financing movements." },
    { term: "Net Cash Movement", definition: "Change in the cash balance across the period — operating, investing and financing cash flows added together." },
    { term: "Investing Cash Flow", definition: "Cash spent on or released by long-term assets, such as building out delivery centers or buying technology." },
    { term: "Financing Cash Flow", definition: "Cash raised from or returned to funders — borrowings, repayments, and shareholder distributions." },
    { term: "Cash Conversion", definition: "How much of reported profit turns into actual operating cash. Below 100% means profit is sitting in receivables rather than the bank." },
    { term: "OCF / EBITDA", definition: "Operating cash flow as a share of EBITDA — a quality-of-earnings check on whether operating profit is converting into cash." },
    { term: "Total Assets", definition: "Everything the business owns that carries economic value — cash, receivables, equipment and delivery infrastructure." },
    { term: "Total Liabilities", definition: "Everything the business owes — payables, borrowings and other obligations to third parties." },
    { term: "Total Equity", definition: "The owners' residual stake: total assets less total liabilities." },
    { term: "Current Ratio", definition: "Short-term assets divided by short-term liabilities. Above 1.0 means the business can cover its near-term obligations." },
    { term: "Debt to Equity", definition: "Borrowings measured against owners' capital. A higher ratio means the business is more reliant on debt funding." },
    { term: "Return on Equity", definition: "Net profit as a percentage of owners' equity — how hard the invested capital is working." },
    { term: "Return on Assets", definition: "Net profit as a percentage of total assets — how efficiently the asset base generates profit." },
    { term: "Asset Turnover", definition: "Revenue generated per dollar of assets. Higher turnover means a leaner business producing more from the same base." },
    { term: "Current Headcount", definition: "Number of employees on the books at the end of the selected period, across all delivery centers." },
    { term: "Revenue per FTE", definition: "Revenue divided by full-time-equivalent headcount — the commercial output of each person in the delivery workforce." },
    { term: "Profit per FTE", definition: "Profit divided by full-time-equivalent headcount. Shows whether added headcount is adding margin, not just revenue." },
    { term: "Operating Cost per FTE", definition: "Total operating cost divided by full-time-equivalent headcount — the all-in cost of keeping one person delivering." },
    { term: "Productive Hours", definition: "Hours spent on client-facing delivery work, as a share of total paid capacity." },
    { term: "Training Load", definition: "Share of paid hours spent in training rather than billable delivery. Necessary investment, but it removes capacity in the short term." },
    { term: "NPS", definition: "Net Promoter Score — how likely clients are to recommend the service, on a scale from -100 to +100." },
    { term: "Best Client", definition: "The client contributing the most revenue in the selected period." },
    { term: "Margin Watch", definition: "The client or unit whose margin is weakest in the selected period and most likely to need pricing or cost action." },
    { term: "Open-Invoice DSO", definition: "Days sales outstanding calculated on invoices still open — how long the currently unpaid book has been waiting." },
  ];

  const ACRONYMS = [
    // Verbatim from _lib/glossary.ts → GLOSSARY_ACRONYMS.
    { term: "DSO", definition: "Days Sales Outstanding" },
    { term: "DPO", definition: "Days Payable Outstanding" },
    { term: "CSAT", definition: "Customer Satisfaction Score" },
    { term: "SLA", definition: "Service Level Agreement" },
    { term: "MO", definition: "Months (used in Cash Runway, e.g., 7.8 months)" },
    // Additional acronyms this dashboard uses (see EXTENDED_ENTRIES caveat).
    { term: "EBITDA", definition: "Earnings Before Interest, Tax, Depreciation and Amortisation" },
    { term: "CAGR", definition: "Compound Annual Growth Rate" },
    { term: "FTE", definition: "Full-Time Equivalent" },
    { term: "AR", definition: "Accounts Receivable" },
    { term: "AP", definition: "Accounts Payable" },
    { term: "OCF", definition: "Operating Cash Flow" },
    { term: "SG&A", definition: "Selling, General and Administrative expenses" },
    { term: "NPS", definition: "Net Promoter Score" },
  ];

  /* ===========================================================================
   * 2. Lookup — same normalisation as _lib/glossary.ts
   * ========================================================================= */
  const normalize = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const BY_KEY = new Map();
  for (const entry of SHEET_ENTRIES) BY_KEY.set(normalize(entry.term), entry);
  for (const entry of EXTENDED_ENTRIES) BY_KEY.set(normalize(entry.term), entry);

  const entryFor = (term) => BY_KEY.get(normalize(term));

  /**
   * KPI label → glossary content, mirroring CARD_GLOSSARY in _lib/glossary.ts.
   * `primary` is the headline definition; `related` are the neighbouring
   * concepts a finance reader needs to interpret the number. Labels absent from
   * this map simply do not flip — same as the overview, which omits cards with
   * no faithful match.
   */
  const CARD_GLOSSARY = {
    // ── Overview ──
    "Total revenue": { primary: "Revenue" },
    "Revenue": { primary: "Revenue" },
    "Revenue CAGR": { primary: "Revenue CAGR", related: ["Revenue"] },
    "EBITDA": { primary: "EBITDA", related: ["EBITDA Margin"] },
    "EBITDA margin": { primary: "EBITDA Margin", related: ["EBITDA"] },
    "Net profit": { primary: "Net Contribution", related: ["Margin"] },
    "Free cash flow": { primary: "Free Cash Flow", related: ["Operating Cash Flow"] },
    "Collection rate": { primary: "Collection Rate", related: ["Collections", "Collection Risk"] },
    "Closing cash": { primary: "Closing Cash", related: ["Cash Balance", "Cash Position"] },
    "Best client": { primary: "Best Client", related: ["Largest Account", "Concentration Risk"] },
    "Margin watch": { primary: "Margin Watch", related: ["Margin Discipline", "Margin"] },

    // ── P&L Insights ──
    "Gross profit": { primary: "Gross Profit", related: ["Gross Margin"] },
    "Operating profit": { primary: "Operating Profit", related: ["SG&A"] },
    "COS": { primary: "Cost of Service", related: ["Gross Profit"] },
    "SG&A": { primary: "SG&A", related: ["Spend"] },
    "Effective tax rate": { primary: "Effective Tax Rate" },

    // ── Cash Flow & Liquidity ──
    "Operating cash flow": { primary: "Operating Cash Flow", related: ["Free Cash Flow"] },
    "Investing cash flow": { primary: "Investing Cash Flow" },
    "Financing cash flow": { primary: "Financing Cash Flow" },
    "Net cash movement": { primary: "Net Cash Movement", related: ["Cash Position"] },
    "Cash conversion": { primary: "Cash Conversion", related: ["Operating Cash Flow"] },
    "OCF / EBITDA": { primary: "OCF / EBITDA", related: ["Operating Cash Flow", "EBITDA"] },
    "Working capital": { primary: "Working Capital", related: ["Cash Balance"] },

    // ── Balance Sheet & Returns ──
    "Total assets": { primary: "Total Assets" },
    "Total liabilities": { primary: "Total Liabilities" },
    "Total equity": { primary: "Total Equity", related: ["Capital"] },
    "Current ratio": { primary: "Current Ratio", related: ["Working Capital"] },
    "Debt to equity": { primary: "Debt to Equity", related: ["Total Equity"] },
    "Return on equity": { primary: "Return on Equity", related: ["Total Equity"] },
    "Return on assets": { primary: "Return on Assets", related: ["Total Assets"] },
    "Asset turnover": { primary: "Asset Turnover", related: ["Total Assets"] },

    // ── AR / AP & Payroll ──
    "Client invoiced": { primary: "Client Invoiced", related: ["Invoices"] },
    "Cash collected": { primary: "Cash Collected", related: ["Collections"] },
    "AR outstanding": { primary: "AR Outstanding", related: ["Receivables Open", "Receivables Exposure"] },
    "Overdue AR": { primary: "Overdue AR", related: ["Overdue Exposure", "Past Due Now"] },
    "AP outstanding": { primary: "AP Outstanding", related: ["DPO (Days Payable Outstanding)"] },
    "AR less AP": { primary: "AR less AP", related: ["DSO / DPO Spread"] },
    "AR/AP Difference": { primary: "AR less AP", related: ["DSO / DPO Spread"] },
    "Open-invoice DSO": { primary: "Open-Invoice DSO", related: ["DSO (Days Sales Outstanding)", "Open Balance"] },
    "Total payroll": { primary: "Total Payroll", related: ["Payroll Elements", "Payroll / Revenue"] },

    // ── Workforce & Quality ──
    "Current headcount": { primary: "Current Headcount" },
    "Revenue per FTE": { primary: "Revenue per FTE", related: ["Utilization"] },
    "Profit per FTE": { primary: "Profit per FTE", related: ["Margin"] },
    "Operating cost per FTE": { primary: "Operating Cost per FTE", related: ["Spend"] },
    "Billable utilization": { primary: "Utilization", related: ["Productive Hours"] },
    "Productive hours": { primary: "Productive Hours", related: ["Utilization"] },
    "Training load": { primary: "Training Load", related: ["Productive Hours"] },
    "SLA compliance": { primary: "SLA Compliance", related: ["Service Miss Rate", "Delivery Pulse"] },
    "CSAT": { primary: "CSAT", related: ["Churn Risk"] },
    "NPS": { primary: "NPS", related: ["CSAT"] },
  };

  // Resolve by normalized label so casing/punctuation drift in index.html
  // (e.g. "AR less AP" vs "AR/AP Difference") still finds the entry.
  const CARD_BY_KEY = new Map();
  for (const label of Object.keys(CARD_GLOSSARY)) {
    CARD_BY_KEY.set(normalize(label), CARD_GLOSSARY[label]);
  }

  /** Mirrors getCardGlossary() — returns null when there is no faithful match. */
  function glossaryForLabel(label) {
    const map = CARD_BY_KEY.get(normalize(label));
    if (!map) return null;
    const primary = entryFor(map.primary);
    if (!primary) return null;
    const related = (map.related || []).map(entryFor).filter(Boolean);
    return { primary, related };
  }

  /** Mirrors acronymsForCardGlossary() — whole-word matches only. */
  function acronymsFor(card) {
    const haystack = [card.primary]
      .concat(card.related)
      .reduce((acc, e) => acc.concat([e.term, e.definition]), [])
      .join(" ");
    return ACRONYMS.filter((a) => {
      // Escape regex metacharacters (SG&A) and only use \b where it is meaningful.
      const t = a.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("(^|[^A-Za-z0-9])" + t + "([^A-Za-z0-9]|$)").test(haystack);
    });
  }

  /* ===========================================================================
   * 3. Back face — DOM port of GlossaryBackFace.tsx
   * ========================================================================= */
  const SVG_NS = "http://www.w3.org/2000/svg";

  function icon(paths, size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const node = document.createElementNS(SVG_NS, d.circle ? "circle" : "path");
      if (d.circle) {
        node.setAttribute("cx", d.circle[0]);
        node.setAttribute("cy", d.circle[1]);
        node.setAttribute("r", d.circle[2]);
      } else {
        node.setAttribute("d", d);
      }
      svg.appendChild(node);
    }
    return svg;
  }

  // lucide-react `Info`, `BookOpen`, `X` — same icon set the overview uses.
  const infoIcon = () => icon([{ circle: [12, 12, 10] }, "M12 16v-4", "M12 8h.01"], 16);
  const bookIcon = () => icon(["M12 7v14", "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"], 14);
  const xIcon = () => icon(["M18 6 6 18", "m6 6 12 12"], 16);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildBackFace(glossary, onClose) {
    const face = el("div", "nq-glossary-face");

    const head = el("div", "nq-glossary-head");
    const eyebrow = el("span", "nq-glossary-eyebrow");
    eyebrow.appendChild(bookIcon());
    eyebrow.appendChild(el("span", null, "Glossary"));
    head.appendChild(eyebrow);
    const xMark = el("span", "nq-glossary-x");
    xMark.setAttribute("aria-hidden", "true");
    xMark.appendChild(xIcon());
    head.appendChild(xMark);
    face.appendChild(head);

    const body = el("div", "nq-glossary-body");
    body.appendChild(el("p", "nq-glossary-term", glossary.primary.term));
    body.appendChild(el("p", "nq-glossary-def", glossary.primary.definition));

    if (glossary.related.length) {
      const dl = el("dl", "nq-glossary-related");
      for (const entry of glossary.related) {
        const row = el("div");
        row.appendChild(el("dt", null, entry.term));
        row.appendChild(el("dd", null, entry.definition));
        dl.appendChild(row);
      }
      body.appendChild(dl);
    }

    const acronyms = acronymsFor(glossary);
    if (acronyms.length) {
      const wrap = el("div", "nq-glossary-acronyms");
      for (const a of acronyms) {
        const pill = el("span", "nq-glossary-acronym");
        pill.appendChild(el("b", null, a.term));
        pill.appendChild(document.createTextNode(" — " + a.definition));
        wrap.appendChild(pill);
      }
      body.appendChild(wrap);
    }

    face.appendChild(body);

    const close = el("button", "nq-glossary-close", "Tap to close");
    close.type = "button";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      onClose();
    });
    face.appendChild(close);

    return face;
  }

  /* ===========================================================================
   * 4. Card decoration
   * ========================================================================= */

  /** Layout edit mode owns the card's clicks — the overview suppresses the flip
   *  the same way via `interactive={!isEditing}`. */
  const isEditingLayout = () => document.body.classList.contains("layout-editing");

  function closeCard(card) {
    const face = card.querySelector(".nq-glossary-face");
    if (face) face.remove();
    card.classList.remove("nq-glossary-open");
    card.setAttribute("aria-expanded", "false");
  }

  function closeAllExcept(keep) {
    document.querySelectorAll(".nq-glossary-open").forEach((card) => {
      if (card !== keep) closeCard(card);
    });
  }

  function toggleCard(card, glossary) {
    if (isEditingLayout()) return;
    if (card.classList.contains("nq-glossary-open")) {
      closeCard(card);
      return;
    }
    closeAllExcept(card);
    const face = buildBackFace(glossary, () => closeCard(card));
    card.appendChild(face);
    card.classList.add("nq-glossary-open");
    card.setAttribute("aria-expanded", "true");
    positionFace(card, face);
  }

  /**
   * The KPI grid is `minmax(185px, 1fr)`, so a tile-width back face leaves a
   * ~4-word measure. Widen it past the tile, and anchor from the right instead
   * of the left when that would push it outside the page gutter.
   */
  const FACE_MIN_WIDTH = 280;

  function positionFace(card, face) {
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width >= FACE_MIN_WIDTH) return;

    const host = card.closest(".main") || document.documentElement;
    const hostRect = host.getBoundingClientRect();
    face.style.minWidth = FACE_MIN_WIDTH + "px";

    if (cardRect.left + FACE_MIN_WIDTH > hostRect.right) {
      face.style.left = "auto";
      face.style.right = "0";
    }
  }

  function decorate(card) {
    if (card.dataset.nqGlossary) return; // already wired this render
    const labelNode = card.querySelector(".kpi-label");
    if (!labelNode) return;

    const glossary = glossaryForLabel(labelNode.textContent || "");
    if (!glossary) return;

    card.dataset.nqGlossary = "1";
    card.classList.add("nq-glossary-card");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-expanded", "false");
    card.setAttribute(
      "aria-label",
      (labelNode.textContent || "").trim() + " — show definition",
    );

    const hint = el("span", "nq-glossary-hint");
    hint.setAttribute("aria-hidden", "true");
    hint.appendChild(infoIcon());
    card.appendChild(hint);

    card.addEventListener("click", () => toggleCard(card, glossary));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleCard(card, glossary);
      } else if (event.key === "Escape" && card.classList.contains("nq-glossary-open")) {
        closeCard(card);
        card.focus();
      }
    });
  }

  function decorateAll() {
    document.querySelectorAll(".kpi-card").forEach(decorate);
  }

  /* ===========================================================================
   * 5. Wire into the render loop
   * ------------------------------------------------------------------------- */
  // `render()` replaces #mainArea's innerHTML then calls this hook, so wrapping
  // it re-decorates on every page switch and date-range change.
  const previousHook = window.afterDashboardRenderEnhanced;
  window.afterDashboardRenderEnhanced = function () {
    if (typeof previousHook === "function") previousHook.apply(this, arguments);
    try {
      decorateAll();
    } catch (error) {
      // A glossary failure must never take the dashboard down with it.
      console.error("[glossary] decoration failed", error);
    }
  };

  // Leaving layout-edit mode (or any late render path that misses the hook)
  // still needs decoration; a cheap observer covers both.
  document.addEventListener("DOMContentLoaded", () => {
    decorateAll();
    const main = document.getElementById("mainArea");
    if (main && typeof MutationObserver !== "undefined") {
      new MutationObserver(() => decorateAll()).observe(main, {
        childList: true,
        subtree: true,
      });
    }
  });

  // Escape anywhere closes an open definition, and clicking outside dismisses it.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllExcept(null);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest || !event.target.closest(".nq-glossary-card")) {
      closeAllExcept(null);
    }
  });
})();
