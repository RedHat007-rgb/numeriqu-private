/**
 * CFO Agenda — the "what needs you today" briefing that opens on entry.
 * ---------------------------------------------------------------------------
 * Restores the agenda modal that used to greet the user on the React overview
 * (apps/web/app/dashboard/_pages/OverviewPage.tsx → CfoAgendaOverlay), which
 * stopped appearing when /dashboard was re-pointed at this embedded dashboard.
 *
 * Two rules carried over from that implementation, both learned the hard way:
 *
 *  1. EVERY LINE IS DERIVED. There is no canned copy and no invented threshold
 *     narrative — each item recomputes from the same helpers the dashboard's
 *     own cards use (flow/arap/balance/workforce/clientRanks/centerStats…) for
 *     the ACTIVE date range, so the agenda can never contradict the page behind
 *     it. If a metric has no data for the selection, its item is dropped rather
 *     than shown as a zero.
 *  2. The reopen fingerprint is the STABLE identity of the items (id:severity),
 *     never their values — fingerprinting the numbers made the old modal
 *     re-open on every refresh and date change.
 *
 * Pure enhancement: everything is guarded, and if this file fails to load the
 * dashboard renders exactly as it did before.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "numeriqu-cfo-agenda-v1";
  // Written by the workspace switcher (apps/web/lib/api/base.ts → SELECTED_ORG_ID_KEY).
  // Same origin as this iframe, so the agenda can tell one workspace from another.
  const ORG_KEY = "nq.organizationId";
  const SNOOZE_MINUTES = 120;
  const MAX_ITEMS = 5;

  /* ===========================================================================
   * 1. Helpers
   * ========================================================================= */

  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  const finite = (value) => Number.isFinite(value);
  const today = () => new Date().toISOString().slice(0, 10);

  function currentOrg() {
    try {
      return localStorage.getItem(ORG_KEY) || "default";
    } catch (error) {
      return "default";
    }
  }

  function readStore() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (error) {
      return {};
    }
  }

  // Dismissals are scoped per workspace: silencing one org's agenda must never
  // silence the next org's, whose numbers the CFO has not seen at all.
  function readPreference() {
    const store = readStore();
    return store.byOrg?.[currentOrg()] || {};
  }

  function writePreference(next) {
    const store = readStore();
    const byOrg = store.byOrg || {};
    byOrg[currentOrg()] = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...store, byOrg, lastOrg: currentOrg() }));
    } catch (error) {
      /* Private-mode browsers simply lose the preference; the agenda still works. */
    }
  }

  function markOrgSeen() {
    const store = readStore();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...store, lastOrg: currentOrg() }));
    } catch (error) {
      /* ignore */
    }
  }

  /* ===========================================================================
   * 2. The agenda itself — one entry per real exception in the account's data
   * ---------------------------------------------------------------------------
   * The workspace's figures are the account's figures: every check below reads
   * the same `DATA` the dashboard's own cards render, so the agenda reports the
   * business as the account actually uses it. `score` orders the queue (higher
   * = more urgent) and `page` is where the evidence lives.
   * ========================================================================= */

  function buildAgenda() {
    const f = flow();
    const a = arap();
    const b = balance();
    const w = workforce();
    const clients = clientRanks();
    const centers = centerStatsEnhanced();
    const cash = latest("closingCash");
    const monthlyLoad = operatingLoadEnhanced();
    const runway = runwayEnhanced();
    const arRisk = collectionRiskEnhanced();
    const revenueChange = change("revenue");
    const items = [];

    const push = (item) => {
      if (item && finite(item.score)) items.push(item);
    };

    /* --- Liquidity ------------------------------------------------------- */
    if (cash > 0 && monthlyLoad > 0 && finite(runway) && runway < 9) {
      push({
        id: "cash-runway",
        page: "cash",
        severity: runway < 3 ? "critical" : runway < 6 ? "watch" : "neutral",
        title: runway < 3 ? "Defend the minimum cash floor" : "Watch the liquidity buffer",
        metric: fmtNum(runway, 1) + " mo",
        detail:
          `${fmtUSD(cash)} closing cash against an average monthly outflow of ${fmtUSD(monthlyLoad)} ` +
          `leaves ${fmtNum(runway, 1)} months of cover. ` +
          (runway < 3
            ? "Phase discretionary payments and confirm the treasury floor this week."
            : "Set the trigger point now, before the next funding or hiring commitment."),
        score: 100 - runway * 8,
      });
    }

    /* --- Collections ----------------------------------------------------- */
    if (a.arOverdue > 0) {
      push({
        id: "overdue-ar",
        page: "arap",
        severity: arRisk > 25 ? "critical" : arRisk > 10 ? "watch" : "neutral",
        title: `Recover ${fmtUSD(a.arOverdue)} of overdue receivables`,
        metric: fmtPct(arRisk),
        detail:
          `${fmtPct(arRisk)} of the ${fmtUSD(a.arOutstanding)} open receivables book is past due, ` +
          `at an open DSO of ${fmtNum(a.openDso)} days against ${fmtNum(a.openDpo)} days to pay suppliers. ` +
          "Assign the largest client-aging balances to named owners with dated recovery commitments.",
        score: 40 + arRisk * 1.6,
      });
    }

    /* --- Supplier obligations vs cash ------------------------------------ */
    const billsCover = safeDiv(a.apOutstanding, cash);
    if (a.apOutstanding > 0 && cash > 0 && billsCover > 0.5) {
      push({
        id: "bills-vs-cash",
        page: "arap",
        severity: billsCover > 1 ? "critical" : "watch",
        title: billsCover > 1 ? "Payables now exceed cash on hand" : "Sequence supplier payments against cash",
        metric: fmtX(billsCover),
        detail:
          `${fmtUSD(a.apOutstanding)} of supplier invoices is open against ${fmtUSD(cash)} of cash ` +
          `(${fmtX(billsCover)} cover) at a ${fmtPct(a.paymentRate)} payment rate. ` +
          "Time payment runs to confirmed receipts and protect critical vendors first.",
        score: 30 + billsCover * 45,
      });
    }

    /* --- Earnings quality ------------------------------------------------ */
    const conversion = safeDiv(f.ocf, f.ebitda);
    if (f.ebitda > 0 && finite(conversion) && conversion < 1) {
      push({
        id: "earnings-to-cash",
        page: "cash",
        severity: conversion < 0.8 ? "watch" : "neutral",
        title: "Close the earnings-to-cash gap",
        metric: fmtX(conversion),
        detail:
          `Operating cash flow of ${fmtUSD(f.ocf)} is only ${fmtX(conversion)} of ${fmtUSD(f.ebitda)} EBITDA. ` +
          "Reconcile the difference through receivables, accruals and settlement timing before treating reported earnings as spendable.",
        score: 55 + (1 - conversion) * 45,
      });
    }

    if (f.fcf < 0) {
      push({
        id: "negative-fcf",
        page: "cash",
        severity: "critical",
        title: "Reverse the free-cash burn",
        metric: fmtUSD(f.fcf),
        detail:
          `Free cash flow is ${fmtUSD(f.fcf)} (${fmtPct(f.fcfMargin)} of revenue) for ${periodLabel()}. ` +
          "Separate recurring burn from temporary working-capital timing before the next commitment.",
        score: 120,
      });
    }

    /* --- Client margin and concentration --------------------------------- */
    const lowMargin = [...clients].sort((x, y) => x.opMargin - y.opMargin)[0];
    if (lowMargin && lowMargin.opMargin < 20) {
      push({
        id: "client-margin",
        page: "pnl",
        severity: lowMargin.opMargin < 10 ? "critical" : "watch",
        title: `Repair the margin on ${lowMargin.name}`,
        metric: fmtPct(lowMargin.opMargin),
        detail:
          `${lowMargin.name} runs at ${fmtPct(lowMargin.opMargin)} operating margin ` +
          `(${fmtPct(lowMargin.grossMargin)} gross) on ${fmtUSD(lowMargin.revenue)} of revenue, ` +
          `against a portfolio gross margin of ${fmtPct(f.grossMargin)}. Reprice, cut delivery leakage or reset scope before renewal.`,
        score: 70 + (20 - lowMargin.opMargin) * 2,
      });
    }

    const byRevenue = [...clients].sort((x, y) => y.revenue - x.revenue);
    const topClient = byRevenue[0];
    const concentration = safeDiv(topClient?.revenue || 0, f.revenue) * 100;
    if (topClient && concentration > 25) {
      push({
        id: "concentration",
        page: "pnl",
        severity: concentration > 40 ? "critical" : "watch",
        title: "Cap revenue concentration",
        metric: fmtPct(concentration),
        detail:
          `${topClient.name} carries ${fmtPct(concentration)} of ${fmtUSD(f.revenue)} selected revenue. ` +
          "Grow the next tier of high-margin accounts so a single renewal cannot reset the plan.",
        score: 35 + concentration,
      });
    }

    /* --- Cost intensity --------------------------------------------------- */
    const payrollShare = safeDiv(a.payroll, f.revenue) * 100;
    if (payrollShare > 55) {
      push({
        id: "payroll-intensity",
        page: "arap",
        severity: payrollShare > 65 ? "critical" : "watch",
        title: "Control payroll intensity",
        metric: fmtPct(payrollShare),
        detail:
          `Payroll of ${fmtUSD(a.payroll)} absorbs ${fmtPct(payrollShare)} of revenue at ${fmtPct(w.utilization)} billable utilization. ` +
          "Review overtime, variable pay and non-billable capacity before approving new headcount.",
        score: 20 + payrollShare,
      });
    }

    /* --- Delivery quality -------------------------------------------------- */
    const atRisk = centers.filter((c) => c.sla < 95 || c.util < 80 || c.csat < 85);
    const worstCenter = centers.length ? centers[centers.length - 1] : null;
    if (worstCenter && atRisk.length) {
      push({
        id: "delivery-risk",
        page: "workforce",
        severity: worstCenter.sla < 90 ? "critical" : "watch",
        title: `${atRisk.length} of ${centers.length} delivery centers miss at least one target`,
        metric: fmtPct(worstCenter.sla),
        detail:
          `${worstCenter.name} is the weakest at ${fmtPct(worstCenter.sla)} SLA, ${fmtPct(worstCenter.util)} utilization ` +
          `and ${fmtPct(worstCenter.csat)} CSAT (targets 95% / 80% / 85%). ` +
          "Service misses turn into credits and churn before they show up in revenue.",
        score: 45 + (95 - worstCenter.sla) * 3,
      });
    }

    /* --- Balance-sheet cover ------------------------------------------------ */
    if (finite(b.currentRatio) && b.currentRatio > 0 && b.currentRatio < 1.5) {
      push({
        id: "current-ratio",
        page: "balance",
        severity: b.currentRatio < 1 ? "critical" : "watch",
        title: "Restore short-term cover",
        metric: fmtX(b.currentRatio),
        detail:
          `Current assets cover current liabilities ${fmtX(b.currentRatio)} with ${fmtUSD(b.workingCapital)} of working capital. ` +
          "Set a minimum cover threshold before any further capital is committed.",
        score: 60 + (1.5 - b.currentRatio) * 40,
      });
    }

    /* --- Trend ------------------------------------------------------------- */
    if (revenueChange && finite(revenueChange.pct) && revenueChange.pct < 0) {
      push({
        id: "revenue-decline",
        page: "pnl",
        severity: revenueChange.pct < -5 ? "critical" : "watch",
        title: "Revenue is contracting",
        metric: fmtPct(revenueChange.pct),
        detail:
          `Revenue is ${fmtPct(Math.abs(revenueChange.pct))} lower ${revenueChange.label}, at ${fmtUSD(f.revenue)} for ${periodLabel()}. ` +
          "Separate lost accounts from volume softness inside existing contracts before resetting the forecast.",
        score: 65 + Math.abs(revenueChange.pct) * 2,
      });
    }

    /* --- Cost leverage — revenue and cost both arrive live, so this holds for
     * any workspace, and it is comparative rather than threshold-based. ----- */
    const cogsChange = change("cogs");
    if (
      revenueChange && cogsChange &&
      finite(revenueChange.pct) && finite(cogsChange.pct) &&
      cogsChange.pct - revenueChange.pct > 1
    ) {
      const gap = cogsChange.pct - revenueChange.pct;
      push({
        id: "cost-growth-gap",
        page: "pnl",
        severity: gap > 5 ? "critical" : "watch",
        title: "Delivery cost is outgrowing revenue",
        metric: `${gap.toFixed(1)} pp`,
        detail:
          `Cost of service rose ${fmtPct(cogsChange.pct)} against ${fmtPct(revenueChange.pct)} revenue growth ${revenueChange.label}, ` +
          `holding gross margin at ${fmtPct(f.grossMargin)}. Find whether the gap is pricing, staffing mix or scope creep before it compounds.`,
        score: 50 + gap * 4,
      });
    }

    /* --- Leverage (balance-sheet rows arrive live) ------------------------- */
    const liabilityShare = safeDiv(b.liabilities, b.assets) * 100;
    if (b.assets > 0 && liabilityShare > 50) {
      push({
        id: "leverage",
        page: "balance",
        severity: liabilityShare > 70 ? "critical" : "watch",
        title: "Leverage is carrying the balance sheet",
        metric: fmtPct(liabilityShare),
        detail:
          `Liabilities of ${fmtUSD(b.liabilities)} fund ${fmtPct(liabilityShare)} of ${fmtUSD(b.assets)} total assets ` +
          `at ${fmtX(b.debtEquity)} debt to equity. Confirm covenant headroom before the next drawdown or capital commitment.`,
        score: 30 + liabilityShare,
      });
    }

    const ranked = items.sort((x, y) => y.score - x.score).slice(0, MAX_ITEMS);

    /* A quiet period is a real answer — say so rather than manufacturing an
     * exception, but still hand over the numbers that earned the verdict. */
    if (!ranked.length) {
      ranked.push({
        id: "no-exceptions",
        page: "overview",
        severity: "good",
        title: "No material exceptions for this period",
        metric: fmtUSD(f.net),
        detail:
          `${periodLabel()} closed at ${fmtUSD(f.revenue)} revenue and ${fmtUSD(f.net)} net profit ` +
          `(${fmtPct(f.netMargin)} margin), with ${fmtUSD(cash)} cash and ${fmtPct(a.collectionRate)} collection efficiency. ` +
          "Nothing crosses the treasury, margin, collection or service thresholds.",
        score: 0,
      });
    }

    return {
      items: ranked,
      period: periodLabel(),
      stats: [
        ["Closing cash", fmtUSD(cash)],
        ["Cash runway", finite(runway) ? fmtNum(runway, 1) + " mo" : "—"],
        ["Overdue AR", fmtUSD(a.arOverdue)],
        ["Headcount", fmtNum(w.headcount)],
      ],
    };
  }

  // Identity only — see the header note on why values must stay out of this.
  const fingerprintOf = (agenda) =>
    agenda.items.map((item) => `${item.id}:${item.severity}`).join("|");

  /* ===========================================================================
   * 3. Rendering
   * ========================================================================= */

  const SEVERITY_LABEL = {
    critical: "Act now",
    watch: "Watch",
    neutral: "Monitor",
    good: "On track",
  };

  function itemHtml(item, index) {
    return `<button type="button" class="nq-agenda-item ${esc(item.severity)}" data-agenda-page="${esc(item.page)}">
      <span class="nq-agenda-num">${String(index + 1).padStart(2, "0")}</span>
      <span class="nq-agenda-body">
        <span class="nq-agenda-item-head">
          <span class="nq-agenda-title">${esc(item.title)}</span>
          <span class="nq-agenda-flag ${esc(item.severity)}">${esc(SEVERITY_LABEL[item.severity] || "Monitor")}</span>
        </span>
        <span class="nq-agenda-detail">${esc(item.detail)}</span>
      </span>
      <span class="nq-agenda-metric mono">${esc(item.metric)}</span>
    </button>`;
  }

  function ensureOverlay() {
    let overlay = document.getElementById("nqAgendaOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "nqAgendaOverlay";
    overlay.className = "nq-agenda-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "CFO agenda");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) dismiss();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function open() {
    const agenda = buildAgenda();
    const overlay = ensureOverlay();
    overlay.dataset.fingerprint = fingerprintOf(agenda);
    overlay.innerHTML = `<div class="nq-agenda-dialog">
      <div class="nq-agenda-head">
        <div>
          <div class="nq-agenda-kicker">CFO Agenda · ${esc(agenda.period)}</div>
          <h2 class="nq-agenda-heading">What needs you today</h2>
        </div>
        <button type="button" class="nq-agenda-close" aria-label="Close CFO agenda" data-agenda-action="dismiss">×</button>
      </div>
      <div class="nq-agenda-stats">
        ${agenda.stats.map(([label, value]) => `<div class="nq-agenda-stat"><span>${esc(label)}</span><b class="mono">${esc(value)}</b></div>`).join("")}
      </div>
      <div class="nq-agenda-list">${agenda.items.map(itemHtml).join("")}</div>
      <div class="nq-agenda-foot">
        <span class="nq-agenda-note">Recalculated from the selected period · click an item to open the evidence</span>
        <div class="nq-agenda-actions">
          <button type="button" class="nq-agenda-btn" data-agenda-action="snooze">Remind me later</button>
          <button type="button" class="nq-agenda-btn" data-agenda-action="hide-today">Hide for today</button>
          <button type="button" class="nq-agenda-btn primary" data-agenda-action="dismiss">Got it</button>
        </div>
      </div>
    </div>`;

    overlay.querySelectorAll("[data-agenda-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.agendaAction;
        if (action === "snooze") snooze();
        else if (action === "hide-today") hideToday();
        else dismiss();
      });
    });
    overlay.querySelectorAll("[data-agenda-page]").forEach((button) => {
      button.addEventListener("click", () => {
        const page = button.dataset.agendaPage;
        dismiss();
        if (page && page !== state.page) {
          state.page = page;
          render();
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    overlay.classList.add("open");
    // The dashboard behind a modal must hold still — a wheel over the backdrop
    // scrolling the page underneath makes the agenda feel like a floating panel
    // rather than something that needs answering.
    document.documentElement.classList.add("nq-agenda-locked");
    overlay.querySelector(".nq-agenda-close")?.focus();
  }

  function close() {
    document.getElementById("nqAgendaOverlay")?.classList.remove("open");
    document.documentElement.classList.remove("nq-agenda-locked");
  }

  function currentFingerprint() {
    return document.getElementById("nqAgendaOverlay")?.dataset.fingerprint || "";
  }

  function dismiss() {
    close();
    writePreference({ ...readPreference(), dismissedFingerprint: currentFingerprint(), snoozeUntil: null });
  }

  function hideToday() {
    close();
    writePreference({
      ...readPreference(),
      dismissedFingerprint: currentFingerprint(),
      hiddenForDate: today(),
      snoozeUntil: null,
    });
  }

  function snooze() {
    close();
    writePreference({
      ...readPreference(),
      snoozeUntil: new Date(Date.now() + SNOOZE_MINUTES * 60_000).toISOString(),
    });
  }

  /* ===========================================================================
   * 4. When it opens by itself
   * ========================================================================= */

  function shouldAutoOpen() {
    const preference = readPreference();
    // Switching workspace re-enters a business the CFO has not been briefed on
    // in this session, so the agenda always leads — no dismissal carries over.
    if (readStore().lastOrg !== currentOrg()) return true;
    if (preference.hiddenForDate === today()) return false;
    if (preference.snoozeUntil && new Date(preference.snoozeUntil).getTime() > Date.now()) return false;
    const agenda = buildAgenda();
    // Nothing to escalate and the user has already seen this exact verdict.
    return preference.dismissedFingerprint !== fingerprintOf(agenda);
  }

  function ensureLaunchButton() {
    const bar = document.querySelector(".controlbar");
    if (!bar) return;
    // The control bar is a grid; the stylesheet pins this button to the right
    // end of the page-nav row so it costs no vertical space of its own. A stray
    // copy parented elsewhere (older markup, re-render) gets pulled back.
    const existing = document.getElementById("nqAgendaLaunch");
    if (existing) {
      if (existing.parentElement !== bar) bar.appendChild(existing);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.id = "nqAgendaLaunch";
    button.className = "nq-agenda-launch";
    button.innerHTML = '<span aria-hidden="true">◈</span> CFO Agenda';
    button.title = "Open the CFO agenda for the selected period";
    button.addEventListener("click", () => open());
    bar.appendChild(button);
  }

  let autoOpened = false;

  function boot() {
    ensureLaunchButton();
    if (autoOpened) return;
    autoOpened = true;
    const show = shouldAutoOpen();
    markOrgSeen();
    if (show) open();
  }

  // Live analytics arrive by postMessage after the embedded workbook has already
  // rendered. If the agenda is on screen when the real figures land, it must
  // restate them rather than leave the CFO reading superseded numbers.
  const previousApply = window.applyPlatformDashboardData;
  if (typeof previousApply === "function") {
    window.applyPlatformDashboardData = function () {
      const result = previousApply.apply(this, arguments);
      try {
        if (document.getElementById("nqAgendaOverlay")?.classList.contains("open")) open();
      } catch (error) {
        console.error("[cfo-agenda] refresh after live data failed", error);
      }
      return result;
    };
  }

  const previousHook = window.afterDashboardRenderEnhanced;
  window.afterDashboardRenderEnhanced = function () {
    if (typeof previousHook === "function") previousHook.apply(this, arguments);
    try {
      ensureLaunchButton();
    } catch (error) {
      console.error("[cfo-agenda] launch button failed", error);
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    // One frame after the first render, so the agenda lands over a drawn page
    // rather than an empty shell.
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          boot();
        } catch (error) {
          console.error("[cfo-agenda] boot failed", error);
        }
      }, 120);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("nqAgendaOverlay")?.classList.contains("open")) dismiss();
  });

  window.openCfoAgenda = open;
})();
