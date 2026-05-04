"use client";

import type { ReactNode } from "react";
import { cn } from "../../../../components/ui/cn";

type Tone = "neutral" | "positive" | "negative";

type StatCardProps = {
  label: string;
  value: string;
  detail?: ReactNode;
  delta?: { value: string; tone: Tone } | null;
  emphasis?: "primary" | "secondary";
  className?: string;
};

const toneClasses: Record<Tone, string> = {
  neutral: "text-text-muted",
  positive: "text-feedback-success",
  negative: "text-feedback-danger",
};

const arrow: Record<Tone, string> = {
  neutral: "→",
  positive: "↑",
  negative: "↓",
};

export function StatCard({
  label,
  value,
  detail,
  delta = null,
  emphasis = "secondary",
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "surface-card relative overflow-hidden",
        emphasis === "primary"
          ? "p-7 ring-1 ring-accent-blue/20"
          : "p-5",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full blur-3xl",
          emphasis === "primary" ? "bg-accent-blue/30" : "bg-accent-blue/10",
        )}
      />
      <div className="relative">
        <p
          className={cn(
            "text-xs font-semibold uppercase tracking-[0.24em] text-text-muted",
          )}
        >
          {label}
        </p>
        <p
          className={cn(
            "mt-3 font-display font-bold text-text-primary",
            emphasis === "primary" ? "text-4xl md:text-5xl" : "text-2xl",
          )}
        >
          {value}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {delta ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full bg-bg-elevated/60 px-2 py-0.5 text-xs font-medium",
                toneClasses[delta.tone],
              )}
            >
              <span aria-hidden>{arrow[delta.tone]}</span>
              {delta.value}
            </span>
          ) : null}
          {detail ? <span className="text-xs text-text-muted">{detail}</span> : null}
        </div>
      </div>
    </div>
  );
}
