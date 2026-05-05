import { AmbientBg } from "./ambient-bg"
import { ChapterMarker } from "./chapter-marker"
import { DashboardMockup } from "./dashboard-mockup"
import { Reveal } from "./reveal"

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 sm:pt-40">
      <AmbientBg />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal>
          <ChapterMarker numeral="I." label="The lie" />
        </Reveal>

        <div className="mt-6 grid grid-cols-12 gap-6">
          <div className="col-span-12 lg:col-span-10 lg:col-start-2">
            <Reveal delay={80}>
              <h1 className="mx-auto text-center font-serif text-balance text-[44px] leading-[1.02] tracking-[-0.02em] text-foreground sm:text-[64px] md:text-[80px] lg:text-[96px]">
                Your numbers were never{" "}
                <span className="text-muted-foreground/70">wrong.</span>
                <br />
                The <em className="italic text-primary">walls</em> between them
                were.
              </h1>
            </Reveal>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-12 gap-6">
          <div className="col-span-12 md:col-span-7 lg:col-span-6">
            <Reveal delay={180}>
              <p className="max-w-xl text-pretty text-[17px] leading-relaxed text-muted-foreground">
                NumeriQ collapses every ERP you run — QuickBooks, Xero, and the
                ones you haven&apos;t connected yet — into a single analytical
                brain. It answers in plain English. It generates live,
                CFO-grade dashboards in under three seconds. And it never makes
                a number up.
              </p>
            </Reveal>

            <Reveal delay={260}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a
                  href="/signup"
                  className="group inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-[0_12px_40px_-12px_oklch(0.72_0.14_165/0.7)] transition-all hover:bg-primary/90"
                >
                  Open your books
                  <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
                </a>
                <a
                  href="#ask"
                  className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/40 px-5 py-3 text-sm text-foreground backdrop-blur-md transition-all hover:bg-secondary/60"
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-60 animate-pulse-dot" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  Watch the agent build a dashboard
                </a>
              </div>
            </Reveal>

            <Reveal delay={340}>
              <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-muted-foreground">
                <span className="font-mono uppercase tracking-[0.2em]">SOC 2</span>
                <span aria-hidden className="h-3 w-px bg-border" />
                <span className="font-mono uppercase tracking-[0.2em]">Bank-grade encryption</span>
                <span aria-hidden className="h-3 w-px bg-border" />
                <span className="font-mono uppercase tracking-[0.2em]">No data resold</span>
              </div>
            </Reveal>
          </div>

          <aside className="col-span-12 md:col-span-5 lg:col-start-9 lg:col-span-4">
            <Reveal delay={220}>
              <div className="relative border-l border-border/70 pl-5">
                <p className="font-serif text-[15px] italic leading-relaxed text-muted-foreground">
                  &ldquo;The CFO opens five tabs to answer one question. By the
                  time the answer is found, the question has already
                  changed.&rdquo;
                </p>
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
                  — A truth every finance team knows
                </p>
              </div>
            </Reveal>
          </aside>
        </div>

        <Reveal delay={300} className="mt-20 sm:mt-24">
          <div className="relative">
            <DashboardMockup />
          </div>
        </Reveal>

        <Reveal delay={120} className="mt-20 border-t border-border/60 pt-8 pb-16">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              Connects to the systems your finance team already lives in
            </p>
            <ul className="flex flex-wrap items-center gap-x-8 gap-y-3 text-[14px] text-muted-foreground/80">
              {["QuickBooks", "Xero", "NetSuite", "Sage", "Stripe", "Brex", "Ramp"].map(
                (n) => (
                  <li key={n} className="font-serif tracking-tight">
                    {n}
                  </li>
                ),
              )}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
