import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"
import { Crown, User } from "lucide-react"

export function Boundaries() {
  return (
    <section className="relative py-32 sm:py-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 lg:col-span-8">
            <Reveal>
              <ChapterMarker numeral="VII." label="Boundaries" />
            </Reveal>
            <Reveal delay={80}>
              <h2 className="mt-6 font-serif text-balance text-[40px] leading-[1.04] tracking-[-0.02em] text-foreground sm:text-[56px] md:text-[68px]">
                Admins see everything. Members see exactly what they{" "}
                <em className="italic text-primary">should.</em>
              </h2>
            </Reveal>
          </div>
          <div className="col-span-12 lg:col-span-4 lg:pt-10">
            <Reveal delay={160}>
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                Permissions aren&apos;t a setting page nobody opens. They&apos;re
                woven through every query, every dashboard, every chat — so
                trust is enforced before it&apos;s asked for.
              </p>
            </Reveal>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-12 gap-5">
          {/* Admin lane */}
          <Reveal delay={120} className="col-span-12 lg:col-span-7">
            <article className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/60 p-7 backdrop-blur-md">
              <header className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-primary">
                    <Crown className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Role · Admin
                    </div>
                    <div className="font-serif text-[22px] leading-none tracking-tight text-foreground">
                      Sees the whole company
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
                  Full access
                </span>
              </header>

              <ul className="mt-7 space-y-4">
                {[
                  ["Connect any number of Xero / QuickBooks orgs", true],
                  ["Configure live or scheduled sync per entity", true],
                  ["Generate dashboards on every entity", true],
                  ["Invite members, scope them to specific orgs", true],
                  ["Grant or revoke dashboard-generation rights", true],
                  ["See every dashboard every member has built", true],
                ].map(([copy], i) => (
                  <li key={i} className="flex items-start gap-3 text-[14px]">
                    <Check />
                    <span className="text-foreground">{copy}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-7 grid grid-cols-3 gap-2">
                {["Acme US", "Acme UK", "Acme EU", "Acme CA", "Acme APAC"].map((n) => (
                  <span
                    key={n}
                    className="rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                  >
                    {n}
                  </span>
                ))}
                <span className="rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
                  + add entity
                </span>
              </div>
            </article>
          </Reveal>

          {/* Member lane */}
          <Reveal delay={220} className="col-span-12 lg:col-span-5">
            <article className="relative h-full overflow-hidden rounded-2xl border border-border/70 bg-card/60 p-7 backdrop-blur-md">
              <header className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-secondary text-foreground">
                    <User className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Role · Member
                    </div>
                    <div className="font-serif text-[22px] leading-none tracking-tight text-foreground">
                      Sees only their slice
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Scoped
                </span>
              </header>

              <ul className="mt-7 space-y-4 text-[14px]">
                <Row check>Access only the entities they&apos;re invited to</Row>
                <Row check>Chat the Analyst within that scope</Row>
                <Row check>Open dashboards their admin shared</Row>
                <Row check={false}>
                  Build new dashboards{" "}
                  <span className="text-muted-foreground">
                    — only if granted
                  </span>
                </Row>
                <Row check={false}>See other entities&apos; numbers</Row>
                <Row check={false}>Modify sync or connections</Row>
              </ul>

              <div className="mt-7 rounded-xl border border-border/60 bg-background/40 p-3 font-serif text-[13px] italic leading-relaxed text-muted-foreground">
                &ldquo;Out of scope. That number lives in Acme APAC, which
                isn&apos;t part of your access. Ask your admin to expand your
                scope.&rdquo;
                <span className="mt-2 block font-mono text-[9px] uppercase not-italic tracking-[0.2em] text-muted-foreground/70">
                  How the Analyst declines, every time
                </span>
              </div>
            </article>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

function Check() {
  return (
    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-primary/20 text-primary">
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5">
        <path
          d="M2 5l2 2 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
        />
      </svg>
    </span>
  )
}

function Row({ check, children }: { check: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      {check ? (
        <Check />
      ) : (
        <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-border bg-background text-muted-foreground">
          <svg viewBox="0 0 10 10" className="h-2 w-2">
            <path
              d="M3 3l4 4M7 3l-4 4"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
          </svg>
        </span>
      )}
      <span
        className={check ? "text-foreground" : "text-muted-foreground/70"}
      >
        {children}
      </span>
    </li>
  )
}
