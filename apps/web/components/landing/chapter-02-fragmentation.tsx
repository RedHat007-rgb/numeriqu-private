import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"

const ledgers = [
  {
    erp: "QuickBooks",
    entity: "Acme US",
    figure: "$2,418,200",
    label: "Q4 revenue",
    rotate: "-rotate-3",
    offset: "translate-y-0",
    delay: 0,
  },
  {
    erp: "Xero",
    entity: "Acme UK",
    figure: "£1,094,400",
    label: "Q4 revenue",
    rotate: "rotate-2",
    offset: "translate-y-8",
    delay: 80,
  },
  {
    erp: "Xero",
    entity: "Acme EU",
    figure: "€842,100",
    label: "Q4 revenue",
    rotate: "-rotate-1",
    offset: "translate-y-2",
    delay: 160,
  },
  {
    erp: "QuickBooks",
    entity: "Acme CA",
    figure: "C$612,800",
    label: "Q4 revenue",
    rotate: "rotate-3",
    offset: "translate-y-10",
    delay: 240,
  },
  {
    erp: "NetSuite",
    entity: "Acme APAC",
    figure: "S$498,300",
    label: "Q4 revenue",
    rotate: "-rotate-2",
    offset: "translate-y-4",
    delay: 320,
  },
]

export function Fragmentation() {
  return (
    <section className="relative py-32 sm:py-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <ChapterMarker numeral="II." label="The fragmentation" />
            </Reveal>
            <Reveal delay={80}>
              <h2 className="mt-6 font-serif text-balance text-[40px] leading-[1.05] tracking-[-0.02em] text-foreground sm:text-[56px] md:text-[64px]">
                Five ledgers.
                <br />
                Five truths.
                <br />
                <em className="italic text-primary">None of them speak.</em>
              </h2>
            </Reveal>
            <Reveal delay={180}>
              <p className="mt-8 max-w-md text-[16px] leading-relaxed text-muted-foreground">
                Every entity you own keeps its own books. Every book has its own
                currency, its own chart of accounts, its own definition of
                &ldquo;revenue.&rdquo; Stitching them together is a Tuesday
                afternoon that becomes a Friday night that becomes a quarter
                you regret.
              </p>
            </Reveal>
            <Reveal delay={260}>
              <ul className="mt-8 space-y-3 font-mono text-[12px] uppercase tracking-[0.18em] text-muted-foreground">
                <li className="flex items-center gap-3">
                  <span className="text-primary">—</span> Spreadsheets that age
                  in hours
                </li>
                <li className="flex items-center gap-3">
                  <span className="text-primary">—</span> Three answers to one
                  question
                </li>
                <li className="flex items-center gap-3">
                  <span className="text-primary">—</span> Decisions made on
                  guesswork
                </li>
              </ul>
            </Reveal>
          </div>

          <div className="relative col-span-12 lg:col-span-7">
            <div className="relative h-[480px] sm:h-[560px]">
              {/* drift lines */}
              <svg
                aria-hidden
                className="absolute inset-0 h-full w-full opacity-30"
                viewBox="0 0 600 560"
                fill="none"
              >
                <path
                  d="M40 100 Q 300 60 560 140"
                  stroke="oklch(0.72 0.14 165 / 0.4)"
                  strokeWidth="1"
                  strokeDasharray="4 6"
                />
                <path
                  d="M60 320 Q 280 380 540 280"
                  stroke="oklch(0.72 0.14 165 / 0.3)"
                  strokeWidth="1"
                  strokeDasharray="4 6"
                />
                <path
                  d="M80 480 Q 320 420 520 500"
                  stroke="oklch(0.72 0.14 165 / 0.25)"
                  strokeWidth="1"
                  strokeDasharray="4 6"
                />
              </svg>

              {ledgers.map((l, i) => (
                <Reveal
                  key={i}
                  delay={l.delay}
                  className={`absolute ${getCardPosition(i)}`}
                >
                  <div
                    className={`${l.rotate} ${l.offset} group rounded-2xl border border-border/70 bg-card/85 p-4 shadow-[0_20px_60px_-20px_oklch(0_0_0/0.6)] backdrop-blur-xl transition-transform hover:rotate-0`}
                  >
                    <div className="flex items-center justify-between gap-6">
                      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-pulse-dot" />
                        {l.erp}
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground/70">
                        {l.entity}
                      </span>
                    </div>
                    <div className="mt-3 font-serif text-[26px] leading-none tracking-tight text-foreground tabular-nums">
                      {l.figure}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {l.label}
                    </div>
                  </div>
                </Reveal>
              ))}

              {/* Question mark over chaos */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="font-serif text-[180px] italic leading-none text-foreground/[0.04] sm:text-[240px]">
                  ?
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function getCardPosition(i: number) {
  const positions = [
    "left-0 top-4",
    "right-4 top-0",
    "left-12 top-44",
    "right-0 top-52",
    "left-1/2 -translate-x-1/2 bottom-0",
  ]
  return positions[i] ?? ""
}
