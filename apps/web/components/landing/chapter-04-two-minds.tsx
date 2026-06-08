import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"
import { MessageCircle, LayoutDashboard } from "lucide-react"

export function TwoMinds() {
  return (
    <section id="two-minds" className="relative py-32 sm:py-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 lg:col-span-7">
            <Reveal>
              <ChapterMarker numeral="IV." label="Two minds" />
            </Reveal>
            <Reveal delay={80}>
              <h2 className="mt-6 font-serif text-balance text-[40px] leading-[1.04] tracking-[-0.02em] text-foreground sm:text-[60px] md:text-[76px]">
                It thinks in <em className="italic text-primary">two</em>{" "}
                distinct ways.
              </h2>
            </Reveal>
          </div>
          <div className="col-span-12 lg:col-span-5 lg:pt-12">
            <Reveal delay={160}>
              <p className="max-w-md text-[16px] leading-relaxed text-muted-foreground">
                One mind reads. One mind builds. They never share a memory,
                never share a permission, never share a context window. That
                separation is the reason you can trust both.
              </p>
            </Reveal>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-12 gap-6">
          {/* The Analyst - RAG */}
          <Reveal delay={120} className="col-span-12 lg:col-span-6">
            <article className="group relative h-full overflow-hidden rounded-2xl border border-border/70 bg-card/60 p-7 backdrop-blur-md transition-colors hover:border-primary/40">
              <header className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-primary">
                    <MessageCircle className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Mind one
                    </div>
                    <div className="font-serif text-[22px] leading-none tracking-tight text-foreground">
                      The Analyst
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  RAG layer
                </span>
              </header>

              <p className="mt-6 font-serif text-[24px] leading-snug text-foreground">
                A grounded conversation with every number on your books.
              </p>
              <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
                Ask anything in plain English. The Analyst retrieves the exact
                rows, ledgers, and periods, cites every source, and refuses to
                guess. If the answer isn&apos;t in your data, it says so.
              </p>

              {/* Sample dialogue */}
              <div className="mt-7 space-y-3 rounded-xl border border-border/60 bg-background/50 p-4">
                <Bubble role="you">
                  How did Acme UK&apos;s gross margin shift from Q2 to Q3?
                </Bubble>
                <Bubble role="ai">
                  Gross margin contracted 2.4 points, from 64.1% to 61.7%.
                  Driven by a £42K rise in third-party hosting (Xero · COGS ·
                  acct 5102) and a one-off £18K vendor true-up in August.
                  <span className="mt-2 block font-mono text-[10px] text-muted-foreground/80">
                    Sources: Xero · Acme UK · 137 line items · synced 41s ago
                  </span>
                </Bubble>
              </div>

              <ul className="mt-6 grid grid-cols-2 gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Dot /> Cited sources
                </li>
                <li className="flex items-center gap-2">
                  <Dot /> Org-scoped only
                </li>
                <li className="flex items-center gap-2">
                  <Dot /> Multi-session
                </li>
                <li className="flex items-center gap-2">
                  <Dot /> Refuses to guess
                </li>
              </ul>
            </article>
          </Reveal>

          {/* The Architect - Agent */}
          <Reveal delay={220} className="col-span-12 lg:col-span-6">
            <article className="group relative h-full overflow-hidden rounded-2xl border border-border/70 bg-card/60 p-7 backdrop-blur-md transition-colors hover:border-accent/40">
              <header className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent/20 text-accent">
                    <LayoutDashboard className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Mind two
                    </div>
                    <div className="font-serif text-[22px] leading-none tracking-tight text-foreground">
                      The Architect
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Agent layer
                </span>
              </header>

              <p className="mt-6 font-serif text-[24px] leading-snug text-foreground">
                A dashboard, designed in seconds, decided in minutes.
              </p>
              <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
                Describe the question. The Architect chooses the right charts,
                KPIs, comparisons, and commentary, then ships a board your CFO
                can read in three seconds and act on in five.
              </p>

              {/* Mini dashboard preview */}
              <div className="mt-7 overflow-hidden rounded-xl border border-border/60 bg-background/50 p-3">
                <div className="grid grid-cols-3 gap-2">
                  <Tile label="ARR" value="$4.28M" tone="up" delta="+12.4%" />
                  <Tile label="Burn" value="$312K" tone="up" delta="-4.1%" />
                  <Tile label="Runway" value="18.4 mo" tone="up" delta="+2.3" />
                </div>
                <div className="mt-2 grid grid-cols-5 items-end gap-1.5 rounded-lg bg-background/40 p-3">
                  {[24, 38, 31, 52, 64, 58, 72, 81, 76, 92].map((h, i) => (
                    <span
                      key={i}
                      style={{ height: `${h}%` }}
                      className="rounded-sm bg-primary/70"
                    />
                  ))}
                </div>
                <p className="mt-2 px-1 font-serif text-[12px] italic leading-snug text-muted-foreground">
                  Suggest reallocating $48K of CS spend to AE coverage in EMEA
                  to protect Q1 NRR.
                </p>
              </div>

              <ul className="mt-6 grid grid-cols-2 gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Dot tone="accent" /> 4+ live charts
                </li>
                <li className="flex items-center gap-2">
                  <Dot tone="accent" /> Re-renders live
                </li>
                <li className="flex items-center gap-2">
                  <Dot tone="accent" /> Saved & shareable
                </li>
                <li className="flex items-center gap-2">
                  <Dot tone="accent" /> Permission-aware
                </li>
              </ul>
            </article>
          </Reveal>
        </div>

        {/* Annotation strip */}
        <Reveal delay={280} className="mt-12">
          <p className="mx-auto max-w-3xl text-center font-serif text-[18px] italic leading-relaxed text-muted-foreground">
            The Analyst answers. The Architect builds. Each lives in its own
            chat, its own context, its own permission scope, so trust never
            leaks.
          </p>
        </Reveal>
      </div>
    </section>
  )
}

function Bubble({ role, children }: { role: "you" | "ai"; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[9px] uppercase ${
          role === "you"
            ? "bg-secondary text-muted-foreground"
            : "bg-primary/20 text-primary"
        }`}
      >
        {role === "you" ? "You" : "AI"}
      </span>
      <p
        className={`text-[13px] leading-relaxed ${
          role === "you" ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {children}
      </p>
    </div>
  )
}

function Tile({
  label,
  value,
  delta,
  tone,
}: {
  label: string
  value: string
  delta: string
  tone: "up" | "down"
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-2.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-serif text-[15px] leading-none tabular-nums text-foreground">
        {value}
      </div>
      <div
        className={`mt-1 text-[10px] ${
          tone === "up" ? "text-primary" : "text-destructive"
        }`}
      >
        {delta}
      </div>
    </div>
  )
}

function Dot({ tone = "primary" }: { tone?: "primary" | "accent" }) {
  return (
    <span
      className={`h-1 w-1 rounded-full ${
        tone === "primary" ? "bg-primary" : "bg-accent"
      }`}
    />
  )
}
