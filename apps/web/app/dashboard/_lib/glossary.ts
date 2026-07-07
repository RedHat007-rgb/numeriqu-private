import type { OverviewCardId } from "./overviewDashboardConfig";

/**
 * Business glossary for the overview dashboard.
 *
 * Source of truth: "Reference Sheet for Demo.xlsx" → Glossary sub-sheet. Every KPI card
 * (and the sub-metrics inside the composite focus cards) maps to a plain-English BPO
 * definition here, so tapping a card reveals what the number actually means to a finance
 * user. Keep the wording verbatim from the sheet — this is the copy the business signed off.
 */

export type GlossaryEntry = { term: string; definition: string };

// Dashboard Keyword → BPO Definition (verbatim from the Glossary sheet).
const GLOSSARY_ENTRIES: GlossaryEntry[] = [
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

// Acronym → expansion (Glossary sheet, second table).
export const GLOSSARY_ACRONYMS: GlossaryEntry[] = [
  { term: "DSO", definition: "Days Sales Outstanding" },
  { term: "DPO", definition: "Days Payable Outstanding" },
  { term: "CSAT", definition: "Customer Satisfaction Score" },
  { term: "SLA", definition: "Service Level Agreement" },
  { term: "MO", definition: "Months (used in Cash Runway, e.g., 7.8 months)" },
];

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const GLOSSARY_BY_KEY = new Map<string, GlossaryEntry>();
for (const entry of GLOSSARY_ENTRIES) GLOSSARY_BY_KEY.set(normalize(entry.term), entry);

/** Look up a glossary entry by its term (normalized, punctuation-insensitive). */
export function glossaryEntry(term: string): GlossaryEntry | undefined {
  return GLOSSARY_BY_KEY.get(normalize(term));
}

export function glossaryDefinition(term: string): string | undefined {
  return glossaryEntry(term)?.definition;
}

/**
 * What each overview card resolves to in the glossary. `primary` is the card's headline
 * definition; `related` are the sub-metrics shown inside composite focus cards, so their
 * definitions surface on the same flip. Cards with no faithful glossary match are omitted
 * and fall back to their built-in config description.
 */
type CardGlossaryMap = { primary: string; related?: string[] };

const CARD_GLOSSARY: Partial<Record<OverviewCardId, CardGlossaryMap>> = {
  "revenue-command": { primary: "Revenue" },
  "margin-quality": { primary: "Gross Margin", related: ["Net Contribution"] },
  "open-invoices": { primary: "Open Invoices" },
  "cash-runway": { primary: "Cash Runway", related: ["Monthly Operating Load"] },
  "working-capital": { primary: "Working Capital", related: ["Cash Balance"] },
  "service-levels": { primary: "Delivery Pulse", related: ["SLA Compliance", "Utilization", "CSAT"] },
  "payroll-discipline": { primary: "Payroll / Revenue" },
  "cash-on-hand": { primary: "Cash Balance", related: ["Cash Position"] },
  "overdue-exposure": { primary: "Overdue Exposure", related: ["Past Due Now"] },
  "invoice-volume": { primary: "Invoices" },
  "burn-rate": { primary: "Monthly Operating Load", related: ["Spend"] },
  "entity-count": { primary: "Entities Live" },
  "collection-risk": { primary: "Collection Risk" },
  "largest-entity": { primary: "Largest Account", related: ["Concentration Risk"] },
  "business-units": { primary: "Best Margin Unit", related: ["Revenue Share"] },
  "cost-elements": { primary: "Payroll Elements" },
  "delivery-centers": { primary: "Delivery Pulse", related: ["SLA Compliance", "Utilization", "CSAT"] },
  "cashflow": { primary: "Operating Cash Flow", related: ["Free Cash Flow"] },
};

export type CardGlossary = {
  /** Headline definition shown as the card's info. */
  primary: GlossaryEntry;
  /** Sub-metric definitions (composite cards). */
  related: GlossaryEntry[];
};

/** Resolve the glossary content for an overview card, or null when there is no match. */
export function getCardGlossary(cardId: OverviewCardId): CardGlossary | null {
  const map = CARD_GLOSSARY[cardId];
  if (!map) return null;
  const primary = glossaryEntry(map.primary);
  if (!primary) return null;
  const related = (map.related ?? [])
    .map((t) => glossaryEntry(t))
    .filter((e): e is GlossaryEntry => !!e);
  return { primary, related };
}

/**
 * Acronyms (DSO, DPO, CSAT, SLA, MO) referenced by a card's glossary content, so the
 * flip can expand them inline — e.g. a Service Levels card surfaces "SLA — Service Level
 * Agreement" and "CSAT — Customer Satisfaction Score". Matches whole words only.
 */
export function acronymsForCardGlossary(card: CardGlossary): GlossaryEntry[] {
  const haystack = [card.primary, ...card.related]
    .flatMap((e) => [e.term, e.definition])
    .join(" ");
  return GLOSSARY_ACRONYMS.filter((a) =>
    new RegExp(`\\b${a.term}\\b`).test(haystack),
  );
}
