"use client";

import type { Connection } from "../../../../lib/api";
import { cardClass, classNames, EmptyState } from "../ui";

export function ConnectionsPanel({
  connections,
  onSync,
  onDelete,
}: {
  connections: Connection[];
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className={cardClass()}>
      <p className="text-sm font-semibold text-slate-200">Connections</p>
      <div className="mt-4 space-y-3">
        {connections.length === 0 ? (
          <EmptyState title="No active connections" detail="Connect Xero or QuickBooks to hydrate the dashboard." />
        ) : (
          connections.map((connection) => (
            <div key={connection.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-semibold text-white">{connection.orgName}</p>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{connection.provider}</p>
                </div>
                <span
                  className={classNames(
                    "rounded-full px-3 py-1 text-xs",
                    connection.isActive ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300",
                  )}
                >
                  {connection.isActive ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => onSync(connection.id)}
                  className="rounded-full bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-400"
                >
                  Run sync
                </button>
                <button
                  onClick={() => onDelete(connection.id)}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:border-rose-300/40 hover:text-rose-200"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

