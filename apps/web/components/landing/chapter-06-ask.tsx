"use client"

import { useEffect, useState } from "react"
import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
} from "recharts"

const PROMPT =
  "Show me Q4 vs plan, top 3 cash risks, and which entity is dragging margin."

const series1 = [120, 142, 138, 168, 184, 176, 198, 214, 232, 248].map((v, i) => ({
  i,
  v,
}))
const series2 = [60, 82, 71, 96, 104, 88, 116, 124, 132, 144].map((v, i) => ({ i, v }))
const series3 = [38, 52, 44, 61, 68, 56, 72, 81].map((v, i) => ({ i, v }))

export function Ask() {
  const [typed, setTyped] = useState("")
  const [building, setBuilding] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let i = 0
    const start = () => {
      setTyped("")
      setBuilding(false)
      setReady(false)
      const id = setInterval(() => {
        i++
        setTyped(PROMPT.slice(0, i))
        if (i >= PROMPT.length) {
          clearInterval(id)
          setTimeout(() => setBuilding(true), 400)
          setTimeout(() => {
            setBuilding(false)
            setReady(true)
          }, 2200)
          setTimeout(() => {
            i = 0
            start()
          }, 8000)
        }
      }, 28)
      return id
    }
    const id = start()
    return () => clearInterval(id)
  }, [])

  return (
    <section id="ask" className="relative py-32 sm:py-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal>
          <ChapterMarker numeral="VI." label="Ask. See. Decide." />
        </Reveal>

        <div className="mt-6 grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-7">
            <Reveal delay={80}>
              <h2 className="font-serif text-balance text-[40px] leading-[1.04] tracking-[-0.02em] text-foreground sm:text-[56px] md:text-[72px]">
                From a question to a{" "}
                <em className="italic text-primary">decision</em> in three
                seconds.
              </h2>
            </Reveal>
          </div>
          <div className="col-span-12 lg:col-span-5 lg:pt-10">
            <Reveal delay={160}>
              <p className="max-w-md text-[16px] leading-relaxed text-muted-foreground">
                Type the way you think. NumeriQ plans the answer, queries the
                ledgers, picks the right shapes for the data, and renders a
                dashboard that&apos;s ready to share — or to act on.
              </p>
            </Reveal>
          </div>
        </div>

        <Reveal delay={140} className="mt-14">
          <div className="grid grid-cols-12 gap-4 lg:gap-6">
            {/* Prompt panel */}
            <div className="col-span-12 lg:col-span-5">
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/70 backdrop-blur-md">
                <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  <span>NumeriQ Agent</span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
                    Live
                  </span>
                </div>

                <div className="p-5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    You ask
                  </div>
                  <p className="mt-2 min-h-[88px] font-serif text-[20px] leading-snug text-foreground">
                    {typed}
                    <span className="ml-0.5 inline-block h-5 w-[2px] translate-y-0.5 bg-primary align-middle animate-pulse-dot" />
                  </p>

                  <div className="mt-6 border-t border-border/60 pt-5">
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Agent plan
                    </div>
                    <ol className="mt-3 space-y-2 text-[13px] text-muted-foreground">
                      <Step done={building || ready}>
                        Pull Q4 actuals across 5 entities
                      </Step>
                      <Step done={building || ready}>
                        Compare to FY25 plan, normalize FX
                      </Step>
                      <Step done={ready}>
                        Identify margin drag &amp; cash risks
                      </Step>
                      <Step done={ready}>
                        Compose dashboard · 4 charts &middot; 3 KPIs
                      </Step>
                    </ol>
                  </div>

                  <div className="mt-5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
                    {ready ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-primary">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        Dashboard ready · 1.4s
                      </span>
                    ) : building ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-accent">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />
                        Building dashboard…
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                        Listening
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Generated dashboard */}
            <div className="col-span-12 lg:col-span-7">
              <div
                className={`relative overflow-hidden rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-md transition-all duration-700 sm:p-5 ${
                  ready ? "opacity-100" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between border-b border-border/60 pb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  <span>Q4 · Plan vs actuals · Acme Holdings</span>
                  <span>Auto-generated</span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3">
                  <Kpi label="vs Plan" value="+108%" tone="up" />
                  <Kpi label="Cash risk" value="2 / 12" tone="warn" />
                  <Kpi label="Margin drag" value="Acme EU" tone="warn" />
                </div>

                <div className="mt-3 grid grid-cols-12 gap-3">
                  <Mini className="col-span-12 sm:col-span-7" label="Revenue · Q4 vs plan">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series1}>
                        <defs>
                          <linearGradient id="ag-1" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="oklch(var(--chart-1))" stopOpacity={0.5} />
                            <stop offset="100%" stopColor="oklch(var(--chart-1))" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <Area
                          type="monotone"
                          dataKey="v"
                          stroke="oklch(var(--chart-1))"
                          strokeWidth={2}
                          fill="url(#ag-1)"
                        />
                        <XAxis
                          dataKey="i"
                          tickLine={false}
                          axisLine={false}
                          tick={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </Mini>
                  <Mini className="col-span-12 sm:col-span-5" label="Cash · 8w outlook">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={series3}>
                        <Line
                          type="monotone"
                          dataKey="v"
                          stroke="oklch(var(--chart-2))"
                          strokeWidth={2}
                          dot={false}
                        />
                        <XAxis
                          dataKey="i"
                          tickLine={false}
                          axisLine={false}
                          tick={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </Mini>
                  <Mini className="col-span-12" label="Margin contribution by entity">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={series2}>
                        <Bar dataKey="v" fill="oklch(var(--chart-1))" radius={[3, 3, 0, 0]} />
                        <XAxis
                          dataKey="i"
                          tickLine={false}
                          axisLine={false}
                          tick={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </Mini>
                </div>

                <p className="mt-4 rounded-xl border border-border/60 bg-background/40 p-3 font-serif text-[14px] italic leading-relaxed text-muted-foreground">
                  Q4 came in 8.2% above plan, but Acme EU dragged consolidated
                  margin by 1.6 points on hosting overrun. Two scheduled
                  receipts move into Jan — flagging short-term cash risk in
                  week 3.
                </p>

                {!ready && (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/20 backdrop-blur-[1px]">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      {building ? "Composing…" : "Waiting on prompt"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={`mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border transition-colors ${
          done
            ? "border-primary bg-primary/20 text-primary"
            : "border-border bg-background"
        }`}
      >
        {done ? (
          <svg viewBox="0 0 10 10" className="h-2 w-2 fill-current">
            <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        ) : null}
      </span>
      <span className={done ? "text-foreground" : "text-muted-foreground"}>
        {children}
      </span>
    </li>
  )
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: "up" | "warn"
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 font-serif text-[18px] leading-none tabular-nums ${
          tone === "up" ? "text-primary" : "text-accent"
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function Mini({
  label,
  children,
  className = "",
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-border/60 bg-background/40 p-3 ${className}`}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 h-[100px] w-full">{children}</div>
    </div>
  )
}
