import { ChapterMarker } from "./chapter-marker"
import { DashboardMockup } from "./dashboard-mockup"
import { Reveal } from "./reveal"

export function OneBrain() {
  return (
    <section
      id="one-brain"
      className="relative overflow-hidden border-y border-border/60 py-32 sm:py-40"
    >
      {/* Soft glow backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 30%, oklch(0.72 0.14 165 / 0.18), transparent 70%)",
        }}
      />
      <div className="nq-grid nq-radial-fade pointer-events-none absolute inset-0 opacity-50" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal>
          <ChapterMarker numeral="III." label="The unification" />
        </Reveal>

        <Reveal delay={80}>
          <h2 className="mt-6 max-w-5xl font-serif text-balance text-[44px] leading-[1.02] tracking-[-0.02em] text-foreground sm:text-[64px] md:text-[88px]">
            Then it all becomes{" "}
            <em className="italic text-primary">one.</em>
          </h2>
        </Reveal>

        <div className="mt-10 grid grid-cols-12 gap-6">
          <div className="col-span-12 md:col-span-7 lg:col-span-6">
            <Reveal delay={160}>
              <p className="text-[17px] leading-relaxed text-muted-foreground">
                NumeriQ reads each ledger in its native dialect, normalizes
                every account, reconciles the differences, and builds a single
                source of truth — refreshed live, never stale, never wrong.
              </p>
            </Reveal>
          </div>
          <div className="col-span-12 md:col-span-5 lg:col-start-9 lg:col-span-4">
            <Reveal delay={240}>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-l border-border/70 pl-6">
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Sync latency
                  </dt>
                  <dd className="mt-1 font-serif text-[28px] leading-none tabular-nums text-foreground">
                    &lt;30s
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Coverage
                  </dt>
                  <dd className="mt-1 font-serif text-[28px] leading-none tabular-nums text-foreground">
                    100%
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Reconciled
                  </dt>
                  <dd className="mt-1 font-serif text-[28px] leading-none tabular-nums text-foreground">
                    Live
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Hallucinations
                  </dt>
                  <dd className="mt-1 font-serif text-[28px] leading-none tabular-nums text-primary">
                    0
                  </dd>
                </div>
              </dl>
            </Reveal>
          </div>
        </div>

        <Reveal delay={200} className="mt-20">
          <DashboardMockup />
        </Reveal>
      </div>
    </section>
  )
}
