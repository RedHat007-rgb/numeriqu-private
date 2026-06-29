"use client";

import Link from "next/link";
import type { DashboardResponse } from "../../../../lib/api";
import { Button } from "../../../../components/ui/Button";
import { StatusPill } from "../../../../components/ui/StatusPill";
import { formatMoneyWithCurrency, formatNumber } from "./format";

export function ConnectedEntitiesCard({
  orgs,
  currency,
}: {
  orgs: DashboardResponse["connectedOrgs"];
  currency: string;
}) {
  return (
    <div className="dashboard-surface h-full p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-blue">
            Connected providers
          </p>
          <h2 className="mt-1.5 font-display text-xl font-bold text-text-primary md:text-[1.45rem]">
            Sources currently feeding spend and invoices
          </h2>
        </div>
        <Link href="/dashboard/integrations">
          <Button variant="secondary" size="sm">
            Manage integrations
          </Button>
        </Link>
      </div>

      <div className="mt-4">
        {orgs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-default px-4 py-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium text-text-primary">No entities connected yet</p>
                <p className="mt-1 text-sm text-text-muted">
                  Connect Xero or QuickBooks to attach real billing, spend, and invoice coverage to the dashboard.
                </p>
              </div>
              <Link href="/dashboard/integrations">
                <Button size="sm">Connect a source</Button>
              </Link>
            </div>
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {orgs.map((org) => (
              <li
                key={`${org.provider}-${org.orgName}`}
                className="rounded-lg border border-default bg-bg-elevated/25 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-text-primary">{org.orgName}</p>
                    <p className="text-xs uppercase tracking-[0.18em] text-text-muted">
                      {org.provider}
                    </p>
                  </div>
                  <StatusPill tone="success">live</StatusPill>
                </div>
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span className="text-text-muted">{formatNumber(org.invoiceCount)} invoices</span>
                  <span className="font-mono text-accent-cyan">{formatMoneyWithCurrency(org.totalRevenue, currency)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
