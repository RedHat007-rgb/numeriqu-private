import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock3,
  Link2,
  Lock,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { ThemeToggle } from "../components/ui/ThemeToggle";
import { HeroBackdrop } from "./_components/landing/HeroBackdrop";

const TRUST_POINTS = [
  "Organization-scoped by default",
  "Supabase sessions, backend-controlled auth",
  "OTP verification via Resend",
  "RAG and Agent separated for safety",
];

const VALUE_STACK = [
  {
    title: "Speed",
    description: "See what changed across entities in minutes, not month-end meetings.",
    icon: Clock3,
  },
  {
    title: "Automation",
    description: "AI assistant and dashboard agent reduce repetitive reporting work.",
    icon: Sparkles,
  },
  {
    title: "Integrations",
    description: "QuickBooks and Xero data normalized into one operating model.",
    icon: Link2,
  },
  {
    title: "Reliability",
    description: "Strict org boundaries, explicit permissions, and auditable workflows.",
    icon: Lock,
  },
];

export default function Home() {
  return (
    <main className="relative overflow-hidden bg-bg-base text-text-primary">
      <section className="relative isolate border-b border-default">
        <HeroBackdrop />
        <div className="relative mx-auto max-w-7xl px-6 pb-24 pt-7">
          <header className="flex items-center justify-between">
            <Link href="/" className="font-display text-xl font-bold text-text-primary">
              Numeriqu
            </Link>
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <Link href="/login">
                <Button variant="secondary" size="sm">
                  Sign in
                </Button>
              </Link>
            </div>
          </header>

          <div className="mt-16 grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-accent-blue/30 bg-accent-blue/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-accent-blue">
                <Building2 size={14} /> Built for modern finance teams
              </p>
              <h1 className="mt-5 max-w-3xl font-display text-5xl font-bold leading-[1.03] text-text-primary md:text-6xl">
                Stop wasting time on manual finance work.
              </h1>
              <p className="mt-5 max-w-2xl text-base text-text-secondary md:text-lg">
                Numeriqu brings ERP data, AI insight, and team execution into one trusted surface so
                CFOs can focus on decisions, not spreadsheet plumbing.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/signup">
                  <Button size="lg">Start with secure OTP</Button>
                </Link>
                <Link href="/dashboard">
                  <Button size="lg" variant="secondary">
                    Explore workspace <ArrowRight size={16} />
                  </Button>
                </Link>
              </div>
              <p className="mt-4 text-xs text-text-muted">
                Every finance query and dashboard is organization-scoped and permission-checked.
              </p>
            </div>

            <div className="surface-card p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
                Why teams trust Numeriqu
              </p>
              <div className="mt-4 space-y-3">
                {TRUST_POINTS.map((point) => (
                  <div key={point} className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3 text-sm text-text-secondary">
                    <span className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 size-4 text-feedback-success" />
                      {point}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid gap-6 md:grid-cols-3">
          <article className="surface-card p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-blue">Problem</p>
            <h2 className="mt-3 text-2xl font-semibold">Finance context is fragmented</h2>
            <p className="mt-2 text-sm text-text-muted">
              ERP data, metrics, and discussions are split across tools with no shared truth.
            </p>
          </article>
          <article className="surface-card p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-blue">Solution</p>
            <h2 className="mt-3 text-2xl font-semibold">One operating layer for finance</h2>
            <p className="mt-2 text-sm text-text-muted">
              Unified data model, AI advisor, and dashboard engine aligned to organization scope.
            </p>
          </article>
          <article className="surface-card p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-blue">Outcome</p>
            <h2 className="mt-3 text-2xl font-semibold">Faster, clearer decisions</h2>
            <p className="mt-2 text-sm text-text-muted">
              Teams see what matters first, act quickly, and track the impact in real time.
            </p>
          </article>
        </div>
      </section>

      <section className="border-y border-default bg-bg-surface/50">
        <div className="mx-auto max-w-7xl px-6 py-16">
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="surface-card p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
                Product experience
              </p>
              <h3 className="mt-3 text-2xl font-semibold text-text-primary">From sync to board narrative</h3>
              <ol className="mt-5 space-y-3 text-sm text-text-secondary">
                <li className="flex gap-3">
                  <span className="mt-0.5 rounded-full bg-accent-blue/15 px-2 py-0.5 text-xs text-accent-blue">1</span>
                  Connect QuickBooks/Xero entities to your organization.
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5 rounded-full bg-accent-blue/15 px-2 py-0.5 text-xs text-accent-blue">2</span>
                  Run sync and normalize records into finance-ready views.
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5 rounded-full bg-accent-blue/15 px-2 py-0.5 text-xs text-accent-blue">3</span>
                  Ask advisor questions, generate dashboards, share inside workspace.
                </li>
              </ol>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {VALUE_STACK.map(({ title, description, icon: Icon }) => (
                <article key={title} className="surface-card p-5">
                  <Icon className="size-5 text-accent-blue" />
                  <h4 className="mt-3 text-lg font-semibold text-text-primary">{title}</h4>
                  <p className="mt-1 text-sm text-text-muted">{description}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-16">
        <div className="surface-card flex flex-col items-start justify-between gap-6 p-8 md:flex-row md:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Ready to start</p>
            <h3 className="mt-2 text-3xl font-semibold text-text-primary">
              Replace finance busywork with confident decisions
            </h3>
            <p className="mt-2 text-sm text-text-muted">
              Connect your data, verify access in minutes, and start running a reliable finance cadence.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/signup">
              <Button size="lg">Create workspace</Button>
            </Link>
            <Link href="/login">
              <Button variant="secondary" size="lg">
                Sign in
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-16">
        <div className="rounded-xl border border-default bg-bg-surface/60 px-4 py-3 text-xs text-text-muted">
          <span className="inline-flex items-center gap-2">
            <TrendingUp className="size-4 text-accent-blue" />
            Designed for CFO workflows: clarity first, auditability always, motion used with restraint.
          </span>
        </div>
      </section>
    </main>
  );
}
