import type { ReactNode } from "react";
import { cn } from "./cn";

type EmptyStateProps = {
  title: string;
  detail?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, detail, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed p-6 text-center",
        "border-subtle bg-bg-elevated/40",
        className,
      )}
    >
      {icon ? (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-blue/10 text-accent-blue">
          {icon}
        </div>
      ) : null}
      <p className="font-display text-lg font-semibold text-text-primary">{title}</p>
      {detail ? <p className="mt-2 max-w-sm text-sm text-text-muted">{detail}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
