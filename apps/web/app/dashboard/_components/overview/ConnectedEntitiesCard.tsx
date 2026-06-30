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
  const totalRevenue = orgs.reduce((sum, org) => sum + (org.totalRevenue ?? 0), 0);

  return (
    <div className="dashboard-focus-card h-full p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7ecaff]">
            Data command
          </p>
          <h2 className="mt-2 font-display text-[1.55rem] font-bold text-white">
            Live finance feeds powering the board view
          </h2>
          <p className="mt-2 text-sm text-[#bfd0eb]">
            Connected entities should feel like a signal map, not an admin list. This is what the CFO can trust right now.
          </p>
        </div>
        <Link href="/dashboard/integrations">
          <Button variant="secondary" size="sm">
            Manage integrations
          </Button>
        </Link>
      </div>

      <div className="mt-4">
        {orgs.length === 0 ? (
          <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium text-white">No live entities yet</p>
                <p className="mt-1 text-sm text-[#bfd0eb]">
                  Connect the accounting and finance sources so this dashboard can graduate from layout to executive instrument.
                </p>
              </div>
              <Link href="/dashboard/integrations">
                <Button size="sm">Connect a source</Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#86a7d0]">Entities live</p>
                <p className="mt-2 text-3xl font-bold text-white">{orgs.length}</p>
              </div>
              <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#86a7d0]">Revenue covered</p>
                <p className="mt-2 text-3xl font-bold text-white">{formatMoneyWithCurrency(totalRevenue, currency)}</p>
              </div>
              <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#86a7d0]">Signal state</p>
                <p className="mt-2 text-3xl font-bold text-white">Live</p>
              </div>
            </div>

            <ul className="grid gap-3 md:grid-cols-2">
            {orgs.map((org) => (
              <li
                key={`${org.provider}-${org.orgName}`}
                className="rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-white">{org.orgName}</p>
                    <p className="text-xs uppercase tracking-[0.18em] text-[#86a7d0]">
                      {org.provider}
                    </p>
                  </div>
                  <StatusPill tone="success">live</StatusPill>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-[#07142f]/65 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#86a7d0]">Invoices</p>
                    <p className="mt-2 text-xl font-bold text-white">{formatNumber(org.invoiceCount)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-[#07142f]/65 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#86a7d0]">Revenue</p>
                    <p className="mt-2 text-xl font-bold text-white">{formatMoneyWithCurrency(org.totalRevenue, currency)}</p>
                  </div>
                </div>
              </li>
            ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
