"use client";

import Link from "next/link";
import type { DashboardResponse } from "../../../../lib/api";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { StatusPill } from "../../../../components/ui/StatusPill";
import { formatMoney, formatNumber } from "./format";

export function ConnectedEntitiesCard({
  orgs,
}: {
  orgs: DashboardResponse["connectedOrgs"];
}) {
  return (
    <div className="surface-card p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
            Connected entities
          </p>
          <h2 className="mt-2 font-display text-xl font-bold text-text-primary md:text-2xl">
            Sources currently feeding the workspace
          </h2>
        </div>
        <Link href="/dashboard/integrations">
          <Button variant="secondary" size="sm">
            Manage integrations
          </Button>
        </Link>
      </div>

      <div className="mt-6">
        {orgs.length === 0 ? (
          <EmptyState
            title="No entities connected yet"
            detail="Connect Xero or QuickBooks from the integrations page to begin syncing."
            action={
              <Link href="/dashboard/integrations">
                <Button size="sm">Connect a source</Button>
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {orgs.map((org) => (
              <li
                key={`${org.provider}-${org.orgName}`}
                className="rounded-2xl border border-default bg-surface-card/40 p-4"
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
                  <span className="font-mono text-accent-cyan">{formatMoney(org.totalRevenue)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
