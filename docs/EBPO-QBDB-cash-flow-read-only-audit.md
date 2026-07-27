# EBPO New Dashboard - QBDB: Cash-Flow Audit

Audit date: July 26, 2026  
Mode: Read-only root-cause investigation  
PBIX inspected: `/Users/basanireddy/Desktop/EBPO New Dashboard - QBDB.pbix`  
Original SHA-256: `d170b51c28e8ab376393294fb91a5b4e4415ce1bdeb95fedea1b75f6d7633732`

## Conclusion

The primary problem is not the sign convention in the core cash-flow measures. It is inconsistent filter context:

- `sfin_fact_cash_flow` is related only to `sfin_dim_date`.
- The Cash Flow & Liquidity page exposes Client, Department, Geography, and Business Unit slicers.
- Those four slicers filter General Ledger revenue, but they cannot filter the cash-flow fact.
- Cash-flow values therefore remain company-wide when one of those slicers is selected.
- Cash-flow margin measures become mathematically invalid because their numerator remains company-wide while their revenue denominator is filtered.

There are three additional defects:

1. `[Cash Balance]` sums a balance repeated on every cash-flow category row, producing a grossly overstated result.
2. The Cash Flow Components visual contains a stale filter referencing the nonexistent `ebpo_dim_date[Year]` field.
3. January 2022 has a source-level opening cash balance of zero even though the cash movement and closing balance imply a $12 million opening balance.

No PBIX content was changed.

## Finding 1 — Disconnected slicers create inconsistent cash-flow values

Severity: Critical when any non-date slicer is used

### Evidence

The only relationship from the cash-flow fact is:

| From | To | Active | Direction |
|---|---|---:|---|
| `sfin_fact_cash_flow[date_key]` | `sfin_dim_date[date_key]` | Yes | Single |

The cash-flow fact has no relationship to:

- `sfin_dim_client`
- `sfin_dim_department`
- `sfin_dim_geography`
- `sfin_dim_business_unit`

The General Ledger fact does have active relationships to all four:

- `sfin_fact_general_ledger[client_key]` → `sfin_dim_client[client_key]`
- `sfin_fact_general_ledger[department_key]` → `sfin_dim_department[department_key]`
- `sfin_fact_general_ledger[geography_key]` → `sfin_dim_geography[geography_key]`
- `sfin_fact_general_ledger[business_unit_key]` → `sfin_dim_business_unit[business_unit_key]`

The Cash Flow & Liquidity page nevertheless contains slicers for:

- `sfin_dim_client[client_name]`
- `sfin_dim_department[department_name]`
- `sfin_dim_geography[country]`
- `sfin_dim_business_unit[business_unit_name]`

### Result

Selecting a client, department, country, or business unit:

- filters `[Total Revenue]`;
- does not filter `[Operating Cash Flow]`;
- does not filter `[Investing Cash Flow]`;
- does not filter `[Financing Cash Flow]`;
- does not filter `[Free Cash Flow]`.

This makes the following measures wrong under those slicers:

```DAX
Operating CF Margin % =
DIVIDE([Operating Cash Flow], [Total Revenue])

Investing CF Margin % =
DIVIDE([Investing Cash Flow], [Total Revenue])

Financing CF Margin % =
DIVIDE([Financing Cash Flow], [Total Revenue])

FCF Margin % =
DIVIDE([Free Cash Flow], [Total Revenue], BLANK())
```

The numerator uses company-wide cash flow while the denominator uses sliced revenue.

### Affected visuals

All cash-flow KPI cards and trends fail to respond correctly to the four disconnected slicers. The most misleading visuals are:

| Visual ID | Title / measure |
|---|---|
| `f73ba9a07b78342c0288` | Operating CF Margin % |
| `933885ff8675596eb5bd` | Investing CF Margin % |
| `ee16ad5a8d0095798418` | Financing CF Margin % |
| `7d0d86e07ab0649d9b96` | Operating Cash Flow card |
| `7c22b65a0d0a9d86c902` | Investing Cash Flow card |
| `923dc01ed77e7db0a53a` | Financing Cash Flow card |
| `de21557be09ad2a11300` | Free Cash Flow card |
| `a5cf0370d01851bd0b09` | Free Cash Flow Trend |
| `b30aef29823ebe8bb11a` | Cash Flow Components |
| `2433944ddd13b486409b` | Net Cash Flow by Cash Flow Category |

### Recommended correction — not applied

Choose one of these semantic decisions:

1. If cash flow is only available at company/date level, remove or disable the four unsupported slicers on this page and clearly label the page as consolidated cash flow.
2. If cash flow must be analyzed by those dimensions, add the corresponding dimension keys to the cash-flow fact at a valid grain and create active relationships.
3. Do not attempt to force the filters through unrelated facts; that would fabricate allocation logic.

## Finding 2 — `[Cash Balance]` is overstated by 126.56×

Severity: Critical wherever the measure is used

### Current DAX

```DAX
Cash Balance =
SUM('sfin_fact_cash_flow'[closing_cash_balance_usd])
```

### Cause

`closing_cash_balance_usd` is a monthly snapshot repeated on every cash-flow category row. There are seven or eight rows per month. Summing the column adds the same month-end balance repeatedly and then adds balances across time.

### Quantified impact

For the embedded dataset:

| Calculation | Value |
|---|---:|
| Current DAX `SUM(closing_cash_balance_usd)` | $5,300,175,224.48 |
| Correct latest closing balance | $41,878,159.12 |
| Overstatement | 126.56× |

The current Cash Flow & Liquidity page does not directly display `[Cash Balance]`, but the measure is present in the semantic model and will return an incorrect value in any future visual or AI query that uses it.

### Recommended correction — not applied

Use the closing balance at the latest visible date, with one value selected rather than summed. The exact DAX should be validated against the desired behavior for totals and multi-entity contexts.

## Finding 3 — Stale filter from the previous date model

Severity: High for the Cash Flow Components visual

Visual `b30aef29823ebe8bb11a`:

- uses `sfin_dim_date[date]` on its active year hierarchy;
- uses cash-flow measures from `_Measures`;
- also retains a visual filter on `ebpo_dim_date[Year]`.

`ebpo_dim_date` does not exist in the current semantic model schema.

This is a leftover artifact from an older dataset/model. Depending on Power BI's handling after refresh or edit, it can be ignored, shown as a broken filter, or contribute to inconsistent visual behavior.

### Recommended correction — not applied

Remove the stale visual-level filter and use only `sfin_dim_date`.

## Finding 4 — January 2022 opening cash is wrong in the source data

Severity: High for opening/closing balance analysis

January 2022 contains:

| Field | Value |
|---|---:|
| Opening cash balance | $0.00 |
| Net cash flow | -$6,434,563.56 |
| Closing cash balance | $5,565,436.44 |

The balance equation does not reconcile:

```text
$0.00 + (-$6,434,563.56) ≠ $5,565,436.44
```

The implied opening balance is exactly $12,000,000:

```text
$12,000,000.00 - $6,434,563.56 = $5,565,436.44
```

Every subsequent month reconciles. This isolates the problem to the initial opening balance in January 2022.

### Recommended correction — not applied

Correct the January 2022 opening balance in the source/ETL layer to $12 million, or explicitly store the initial funding/balance event that creates it.

## Finding 5 — Duplicate typo measure is invalid but not currently used

Severity: Medium latent risk

The model contains both:

- `[Operating Cash Outflow]` — valid and used by `[Operating Cash Flow]`;
- `[perating Cash Outflow]` — misspelled duplicate.

The misspelled measure filters:

```DAX
'sfin_fact_cash_flow'[cash_flow_category] = "Operating"
```

No cash-flow category has the value `Operating`. The actual operating categories are:

- Bank charges
- Collections from customers
- Income taxes paid
- Payroll paid
- Vendor payments

Therefore the misspelled measure returns blank/zero in normal context. It is not currently referenced by `[Operating Cash Flow]`, so it is not causing the displayed Operating Cash Flow value today.

### Recommended correction — not applied

Delete or hide the misspelled measure after confirming no external report depends on it.

## Core measure validation

The cash outflow column stores positive amounts. Therefore this operating cash-flow formula is correct:

```DAX
Operating Cash Flow =
[Operating Cash Inflow] - [Operating Cash Outflow]
```

Investing and financing rows store negative `net_cash_flow_usd`, making this Free Cash Flow definition mathematically equivalent to OCF minus capital expenditure:

```DAX
Free Cash Flow =
[Operating Cash Flow] + [Investing Cash Flow]
```

### Embedded dataset totals

| Year | Revenue | Operating CF | Investing CF | Financing CF | Free CF | Net CF |
|---:|---:|---:|---:|---:|---:|---:|
| 2022 | $108,480,539.02 | -$4,888,759.00 | -$1,847,791.18 | -$1,051,825.51 | -$6,736,550.18 | -$7,788,375.69 |
| 2023 | $117,947,815.72 | $8,920,745.84 | -$1,926,585.73 | -$1,049,730.86 | $6,994,160.11 | $5,944,429.25 |
| 2024 | $128,161,037.96 | $15,665,375.91 | -$2,041,718.25 | -$1,053,182.05 | $13,623,657.66 | $12,570,475.61 |
| 2025 | $138,523,779.80 | $22,293,427.05 | -$2,091,720.06 | -$1,050,077.04 | $20,201,706.99 | $19,151,629.95 |

Cumulative 2022–2025:

- Net cash flow: $29,878,159.12
- Implied initial cash: $12,000,000.00
- Ending cash: $41,878,159.12

These totals reconcile, supporting the conclusion that the main value problem is filter context and balance aggregation rather than the core cash-flow arithmetic.

## Verification checklist

After corrections are eventually authorized:

1. Select each Client, Department, Geography, and Business Unit slicer and verify whether cash flow should change or the slicer should be unavailable.
2. Verify cash-flow margins use numerator and denominator at the same dimensional grain.
3. Check the Cash Flow Components visual for any reference to `ebpo_dim_date`.
4. Validate `[Cash Balance]` at month, year, and grand-total levels.
5. Confirm January 2022 opening cash is $12 million or is supported by an explicit funding event.
6. Reconcile `opening cash + net movement = closing cash` for every month.
7. Confirm ending December 2025 cash is $41,878,159.12.

