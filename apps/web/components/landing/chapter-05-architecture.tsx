import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"

export function Architecture() {
  return (
    <section
      id="architecture"
      className="relative overflow-hidden border-y border-border/60 bg-card/30 py-32 sm:py-40"
    >
      <div className="nq-grid nq-radial-fade pointer-events-none absolute inset-0 opacity-40" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <ChapterMarker numeral="V." label="The architecture" />
            </Reveal>
            <Reveal delay={80}>
              <h2 className="mt-6 font-serif text-balance text-[40px] leading-[1.04] tracking-[-0.02em] text-foreground sm:text-[56px] md:text-[68px]">
                Built for the way your{" "}
                <em className="italic text-primary">company</em> actually
                works.
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-md text-[16px] leading-relaxed text-muted-foreground">
                Three Xero books in three regions. Two QuickBooks files for
                two subsidiaries. One brain that holds them all in mind at
                once, and never lets one room see another room&apos;s
                numbers.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <ul className="mt-8 space-y-4 text-[14px] text-muted-foreground">
                <Bullet>
                  <span className="text-foreground">Per-entity isolation</span>
                  &nbsp;- enforced at the database, the API, and the UI.
                </Bullet>
                <Bullet>
                  <span className="text-foreground">Role-aware everything</span>
                  &nbsp;- what an admin sees, a member never accidentally
                  glimpses.
                </Bullet>
                <Bullet>
                  <span className="text-foreground">Live or scheduled sync</span>
                  &nbsp;- streaming where it matters, every 8h where it
                  doesn&apos;t.
                </Bullet>
                <Bullet>
                  <span className="text-foreground">One unified schema</span>
                  &nbsp;- so a question in Acme US is answered the same way
                  in Acme APAC.
                </Bullet>
              </ul>
            </Reveal>
          </div>

          <div className="col-span-12 lg:col-span-7">
            <Reveal delay={140}>
              <OrgGraph />
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 leading-relaxed">
      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
      <span>{children}</span>
    </li>
  )
}

function OrgGraph() {
  const ledgers = [
    { name: "Acme US", erp: "QuickBooks", x: 8, y: 12 },
    { name: "Acme UK", erp: "Xero", x: 8, y: 32 },
    { name: "Acme EU", erp: "Xero", x: 8, y: 52 },
    { name: "Acme CA", erp: "QuickBooks", x: 8, y: 72 },
    { name: "Acme APAC", erp: "Xero", x: 8, y: 92 },
  ]

  return (
    <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl border border-border/70 bg-background/40 p-6 backdrop-blur-md sm:aspect-[5/4] sm:p-8">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <span>Account · Acme Holdings</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
          5 entities · live
        </span>
      </div>

      <svg
        aria-hidden
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {ledgers.map((l, i) => (
          <line
            key={i}
            x1="22"
            y1={l.y + 4}
            x2="78"
            y2={50}
            stroke="oklch(0.72 0.14 165 / 0.4)"
            strokeWidth="0.2"
            strokeDasharray="0.6 0.8"
          >
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to="-12"
              dur={`${4 + i * 0.4}s`}
              repeatCount="indefinite"
            />
          </line>
        ))}
      </svg>

      <div className="relative mt-8 grid h-[calc(100%-3rem)] grid-cols-12 items-stretch gap-4">
        {/* Left rail - ledgers */}
        <ul className="col-span-5 flex flex-col justify-between gap-2 sm:col-span-4">
          {ledgers.map((l) => (
            <li
              key={l.name}
              className="flex items-center justify-between rounded-lg border border-border/60 bg-card/70 px-3 py-2.5 backdrop-blur"
            >
              <div>
                <div className="font-serif text-[14px] leading-none text-foreground">
                  {l.name}
                </div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  {l.erp}
                </div>
              </div>
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
            </li>
          ))}
        </ul>

        {/* Center - the brain */}
        <div className="relative col-span-7 flex items-center justify-center sm:col-span-8">
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-12 rounded-full opacity-50 blur-3xl"
              style={{
                background:
                  "radial-gradient(closest-side, oklch(0.72 0.14 165 / 0.5), transparent 70%)",
              }}
            />
            <div className="relative grid h-44 w-44 place-items-center rounded-full border border-primary/30 bg-card/70 backdrop-blur-xl sm:h-56 sm:w-56">
              <div className="absolute inset-3 rounded-full border border-border/70" />
              <div className="absolute inset-6 rounded-full border border-border/50" />
              <div className="text-center">
                <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
                  Numeriqu
                </div>
                <div className="font-serif text-[22px] leading-tight text-foreground sm:text-[26px]">
                  One brain
                </div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
                  Unified ledger
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
