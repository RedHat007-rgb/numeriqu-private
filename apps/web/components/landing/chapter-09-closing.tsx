import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"

export function Closing() {
  return (
    <section className="relative overflow-hidden py-40 sm:py-56">
      {/* Big atmospheric glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(50% 60% at 50% 70%, oklch(0.72 0.14 165 / 0.22), transparent 70%)",
        }}
      />
      <div className="nq-grid nq-radial-fade pointer-events-none absolute inset-0 opacity-50" />

      <div className="relative mx-auto max-w-7xl px-4 text-center sm:px-6">
        <Reveal>
          <ChapterMarker numeral="IX." label="The close" className="justify-center" />
        </Reveal>

        <Reveal delay={120}>
          <h2 className="mx-auto mt-8 max-w-6xl font-serif text-balance text-[44px] leading-[1.02] tracking-[-0.025em] text-foreground sm:text-[64px] md:text-[80px] lg:text-[96px]">
            Stop reading dashboards.
            <br />
            Start having <em className="italic text-primary">conversations</em>.
          </h2>
        </Reveal>

        <Reveal delay={220}>
          <p className="mx-auto mt-8 max-w-xl text-pretty text-[17px] leading-relaxed text-muted-foreground">
            With your numbers. Connecting your first ledger takes less than a
            second, then your books answer back.
          </p>
        </Reveal>

        <Reveal delay={300}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-[0_16px_50px_-14px_oklch(0.72_0.14_165/0.7)] transition-all hover:bg-primary/90"
            >
              Open the brain
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </a>
            <a
              href="/contact"
              className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/40 px-6 py-3.5 text-sm text-foreground backdrop-blur-md transition-all hover:bg-secondary/60"
            >
              Talk to the team
            </a>
          </div>
        </Reveal>

        <Reveal delay={400}>
          <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Read-only ERP access · One-click connect · Cancel anytime
          </p>
        </Reveal>
      </div>
    </section>
  )
}
