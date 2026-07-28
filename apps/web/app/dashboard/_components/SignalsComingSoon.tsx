"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Bell,
  FileText,
  Gauge,
  LayoutDashboard,
  MessageSquare,
  Radar,
  Receipt,
  Scale,
  TrendingDown,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { StatusPill } from "../../../components/ui/StatusPill";
import { cn } from "../../../components/ui/cn";

/**
 * Locked-state page for Signals.
 *
 * Mirrors the visual language of `PrismComingSoonOverlay` (RagWorkbench.tsx) —
 * same 28px card, top gradient rule, two-column split, launch-status panel and
 * exit buttons — but the body is an explanation rather than a placeholder: a
 * CFO landing here should leave understanding what Signals is for.
 *
 * The copy is derived from the shipped domain model, not invented: the watch
 * list below is the `SignalType` union, the journey is the `SignalStatus`
 * workflow, and "what every signal carries" is the `SignalSummary` /
 * `SignalDetail` shape (lib/api/types.ts). Keep them in step — if a signal type
 * is added or renamed, this page should say so too.
 *
 * Rendered *instead of* SignalsPage while locked, so no signal API calls are
 * made for a feature the user cannot reach.
 */

type WatchItem = { icon: LucideIcon; title: string; body: string };

/** One entry per member of the `SignalType` union. */
const WATCHES: WatchItem[] = [
  {
    icon: TrendingDown,
    title: "Revenue variance",
    body: "Revenue moved further than your own run-rate explains — up or down. The interesting part is usually which client moved, not the total.",
  },
  {
    icon: Scale,
    title: "Margin pressure",
    body: "Delivery cost is climbing faster than the revenue it supports. Caught early this is a pricing conversation; caught late it is a write-off.",
  },
  {
    icon: Wallet,
    title: "Cash risk",
    body: "The cash curve is bending toward a month you would struggle to fund, based on the burn you are actually running.",
  },
  {
    icon: Receipt,
    title: "Collections risk",
    body: "Invoices that used to be paid on time have quietly stopped being paid on time. Revenue is booked; the cash is not arriving.",
  },
  {
    icon: Users,
    title: "Concentration risk",
    body: "Too much of the book now leans on too few clients. Healthy growth and dangerous dependence look identical until one of them leaves.",
  },
  {
    icon: Banknote,
    title: "Payroll pressure",
    body: "Workforce cost is absorbing more of every revenue dollar than the operating model assumes — the largest cost line in a BPO drifting off plan.",
  },
  {
    icon: Gauge,
    title: "Utilization risk",
    body: "Paid capacity is drifting away from billable work. You are still paying for the hours; clients have stopped paying for them.",
  },
];

/** The `SignalStatus` workflow, minus the DISMISSED side exit (noted separately). */
const JOURNEY = [
  { step: "Detected", body: "The metric breaches its threshold and a signal opens itself. Nobody has to notice first." },
  { step: "Acknowledged", body: "Someone owns it. It leaves the shared inbox and joins a person's queue." },
  { step: "Investigating", body: "Evidence is attached, the thread runs on the signal, and the working is visible." },
  { step: "Resolved", body: "It closes with a reason recorded — so next quarter you can see what you actually did." },
];

const CARRIES = [
  { icon: Banknote, label: "Impact in dollars", body: "What this is worth, not just that it happened." },
  { icon: BadgeCheck, label: "A confidence score", body: "How sure the detection is, stated up front." },
  { icon: FileText, label: "Its evidence", body: "The rows behind the number, not a summary of them." },
  { icon: MessageSquare, label: "A comment thread", body: "The decision trail lives with the finding." },
  { icon: LayoutDashboard, label: "A board pack", body: "Export the whole thing when it needs to leave the room." },
];

export function SignalsComingSoon() {
  const router = useRouter();

  return (
    <div className="relative min-h-full px-1 py-2">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(70,126,255,0.18),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(0,199,210,0.12),transparent_30%)]"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.98, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.24, ease: "easeOut" }}
        className="relative mx-auto w-full max-w-6xl overflow-hidden rounded-[28px] border border-white/10 bg-bg-card/92 shadow-2xl shadow-black/45 ring-1 ring-white/5"
      >
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#2b7cff_0%,#00c7d2_50%,#2b7cff_100%)]"
        />

        <div className="grid gap-0 lg:grid-cols-[1.35fr_0.65fr]">
          {/* ── Explanation ─────────────────────────────────────────── */}
          <div className="border-b border-white/8 p-6 sm:p-8 lg:border-b-0 lg:border-r lg:border-white/8">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-blue/10 ring-1 ring-accent-blue/20">
                <Radar size={22} className="text-accent-blue" />
              </div>
              <StatusPill
                tone="neutral"
                withDot={false}
                className="px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]"
              >
                Coming soon
              </StatusPill>
            </div>

            <h2 className="mt-5 max-w-xl font-display text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Signals watches the ledger so you don&rsquo;t have to.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-text-muted sm:text-base">
              Your numbers move every single day, and almost all of that movement is noise.
              Signals is the part of NumeriQu that reads the finance data while you are doing
              something else, and interrupts you only when a change is genuinely worth a CFO&rsquo;s
              attention &mdash; with the evidence already attached.
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-text-muted sm:text-base">
              We&rsquo;re still finishing it, so this area stays locked. Here is exactly what
              it will do when it opens.
            </p>

            {/* What it watches — the SignalType union */}
            <section className="mt-8" aria-labelledby="signals-watches">
              <h3
                id="signals-watches"
                className="text-[11px] font-semibold uppercase tracking-[0.28em] text-accent-cyan"
              >
                What it watches for
              </h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {WATCHES.map(({ icon: Icon, title, body }, index) => (
                  <div
                    key={title}
                    className={cn(
                      "rounded-2xl border border-white/8 bg-white/[0.03] p-4 ring-1 ring-white/5",
                      // Odd count — let the last one span the row rather than orphan.
                      index === WATCHES.length - 1 &&
                        WATCHES.length % 2 === 1 &&
                        "sm:col-span-2",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-blue/10 text-accent-blue ring-1 ring-accent-blue/20">
                        <Icon size={15} />
                      </span>
                      <p className="text-sm font-semibold text-text-primary">{title}</p>
                    </div>
                    <p className="mt-2.5 text-[13px] leading-6 text-text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* How a signal travels — the SignalStatus workflow */}
            <section className="mt-8" aria-labelledby="signals-journey">
              <h3
                id="signals-journey"
                className="text-[11px] font-semibold uppercase tracking-[0.28em] text-accent-cyan"
              >
                How a signal travels
              </h3>
              <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {JOURNEY.map((stage, index) => (
                  <li
                    key={stage.step}
                    className="relative rounded-2xl border border-white/8 bg-white/[0.03] p-4 ring-1 ring-white/5"
                  >
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <p className="mt-1.5 text-sm font-semibold text-text-primary">{stage.step}</p>
                    <p className="mt-2 text-[13px] leading-6 text-text-muted">{stage.body}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[13px] leading-6 text-text-muted">
                Not every signal deserves the full trip. Anything you dismiss records{" "}
                <em className="not-italic text-text-secondary">why</em> it was dismissed, so the
                detection gets less noisy over time instead of being ignored forever.
              </p>
            </section>
          </div>

          {/* ── Status rail ─────────────────────────────────────────── */}
          {/* Deliberately not `justify-between`: the explanation column is far
              taller than this one, which would strand the buttons at the bottom
              of a screen-high void. The rail stays a top-aligned stack. */}
          <div className="flex flex-col gap-6 bg-white/[0.03] p-6 sm:p-8">
            <div className="space-y-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-text-muted">
                  Launch status
                </p>
                <div className="mt-4 rounded-3xl border border-white/8 bg-bg-surface/55 p-4 ring-1 ring-white/5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-text-primary">Signals</span>
                    <span className="rounded-full bg-accent-blue/12 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-accent-blue">
                      Building
                    </span>
                  </div>
                  <div className="mt-4 h-3 rounded-full bg-white/8">
                    <div className="h-3 w-[45%] rounded-full bg-[linear-gradient(90deg,#2b7cff,#00c7d2)]" />
                  </div>
                  <p className="mt-3 text-[12px] leading-5 text-text-muted">
                    Detection and evidence are in place. We are still tuning thresholds so the
                    inbox stays worth opening.
                  </p>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-text-muted">
                  Every signal arrives with
                </p>
                <ul className="mt-4 space-y-2.5">
                  {CARRIES.map(({ icon: Icon, label, body }) => (
                    <li key={label} className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-cyan/10 text-accent-cyan ring-1 ring-accent-cyan/20">
                        <Icon size={13} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-text-primary">{label}</p>
                        <p className="mt-0.5 text-[12px] leading-5 text-text-muted">{body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 ring-1 ring-white/5">
                <div className="flex items-center gap-2">
                  <Bell size={14} className="text-accent-cyan" />
                  <p className="text-[13px] font-semibold text-text-primary">
                    And you can point it yourself
                  </p>
                </div>
                <p className="mt-2 text-[12px] leading-5 text-text-muted">
                  Watchlists let you name the line you care about &mdash; a metric, an entity, a
                  threshold &mdash; and Signals will watch that one for you at the severity you
                  set. The defaults are a starting point, not the whole job.
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => router.back()}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-default bg-bg-surface px-4 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-elevated/70"
              >
                <ArrowLeft size={16} />
                Go back
              </button>
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-accent-blue px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-blue/90"
              >
                <LayoutDashboard size={16} />
                Back to dashboard
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
