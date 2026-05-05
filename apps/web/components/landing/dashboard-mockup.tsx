"use client"

import { useEffect, useState } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
} from "recharts"
import {
  ArrowDownRight,
  ArrowUpRight,
  Sparkles,
  Wallet,
  Receipt,
  TrendingUp,
} from "lucide-react"
import { cn } from "@/lib/utils"

const revenue = [
  { m: "Jan", v: 184 },
  { m: "Feb", v: 212 },
  { m: "Mar", v: 198 },
  { m: "Apr", v: 246 },
  { m: "May", v: 268 },
  { m: "Jun", v: 254 },
  { m: "Jul", v: 289 },
  { m: "Aug", v: 312 },
  { m: "Sep", v: 305 },
  { m: "Oct", v: 338 },
  { m: "Nov", v: 362 },
  { m: "Dec", v: 391 },
]

const cash = [
  { m: "W1", inflow: 84, outflow: 62 },
  { m: "W2", inflow: 92, outflow: 71 },
  { m: "W3", inflow: 78, outflow: 64 },
  { m: "W4", inflow: 108, outflow: 82 },
  { m: "W5", inflow: 124, outflow: 88 },
  { m: "W6", inflow: 116, outflow: 79 },
  { m: "W7", inflow: 138, outflow: 96 },
  { m: "W8", inflow: 152, outflow: 102 },
]

const segments = [
  { name: "SaaS", value: 48 },
  { name: "Services", value: 26 },
  { name: "Hardware", value: 16 },
  { name: "Other", value: 10 },
]

const segColors = [
  "oklch(var(--chart-1))",
  "oklch(var(--chart-2))",
  "oklch(var(--chart-3))",
  "oklch(var(--chart-5))",
]

export function DashboardMockup({ className }: { className?: string }) {
  // animate the live KPI values
  const [arr, setArr] = useState(4_284_000)
  const [burn, setBurn] = useState(312_400)

  useEffect(() => {
    const id = setInterval(() => {
      setArr((v) => v + Math.floor(Math.random() * 1200) - 400)
      setBurn((v) => v + Math.floor(Math.random() * 600) - 300)
    }, 2400)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={cn("relative", className)}>
      {/* glow underlay */}
      <div
        aria-hidden
        className="absolute -inset-x-10 -top-10 -bottom-10 -z-10 rounded-[2rem] opacity-60 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 30%, oklch(0.72 0.14 165 / 0.35), transparent 70%)",
        }}
      />

      <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-card/80 shadow-[0_30px_120px_-30px_oklch(0_0_0/0.8)] backdrop-blur-xl">
        {/* Window chrome */}
        <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-[11px] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-60 animate-pulse-dot" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            app.NumeriQ.com / acme-holdings
          </div>
          <div className="flex items-center gap-1.5">
            <span className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
              Q4 · FY25
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="grid grid-cols-12 gap-3 p-3 sm:p-4">
          {/* Left rail — agent prompt */}
          <div className="col-span-12 lg:col-span-4">
            <div className="flex h-full flex-col gap-3">
              <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  AI Agent
                </div>
                <p className="mt-2 font-serif text-[15px] leading-snug text-foreground">
                  &ldquo;Show me Q4 performance vs plan, with cash runway and top 3 risks.&rdquo;
                </p>
                <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="h-1 w-1 rounded-full bg-primary animate-pulse-dot" />
                  Building dashboard · 1.2s
                </div>
              </div>

              <KpiTile
                icon={<Wallet className="h-3.5 w-3.5" />}
                label="ARR"
                value={`$${(arr / 1_000_000).toFixed(2)}M`}
                delta="+12.4%"
                positive
              />
              <KpiTile
                icon={<Receipt className="h-3.5 w-3.5" />}
                label="Burn / mo"
                value={`$${(burn / 1000).toFixed(1)}K`}
                delta="-4.1%"
                positive
              />
              <KpiTile
                icon={<TrendingUp className="h-3.5 w-3.5" />}
                label="Runway"
                value="18.4 mo"
                delta="+2.3 mo"
                positive
              />
            </div>
          </div>

          {/* Right — charts */}
          <div className="col-span-12 lg:col-span-8 grid grid-cols-12 gap-3">
            {/* Revenue area */}
            <Card className="col-span-12">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Revenue · trailing 12 months
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="font-serif text-2xl">$3,479,200</span>
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <ArrowUpRight className="h-3 w-3" /> 18.2%
                    </span>
                  </div>
                </div>
                <Legend />
              </div>
              <div className="mt-2 h-[140px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenue} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="nq-rev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="oklch(var(--chart-1))" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="oklch(var(--chart-1))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="m"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "oklch(var(--muted-foreground))", fontSize: 10 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="v"
                      stroke="oklch(var(--chart-1))"
                      strokeWidth={2}
                      fill="url(#nq-rev)"
                      isAnimationActive
                      animationDuration={1800}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {/* Cash flow */}
            <Card className="col-span-12 sm:col-span-7">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Weekly cash flow
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-serif text-xl">+$612K</span>
                <span className="text-[10px] text-muted-foreground">net · last 8 weeks</span>
              </div>
              <div className="mt-2 h-[110px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={cash} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barCategoryGap="20%">
                    <XAxis
                      dataKey="m"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "oklch(var(--muted-foreground))", fontSize: 10 }}
                    />
                    <Bar dataKey="inflow" fill="oklch(var(--chart-1))" radius={[3, 3, 0, 0]} animationDuration={1400} />
                    <Bar dataKey="outflow" fill="oklch(var(--chart-5))" radius={[3, 3, 0, 0]} animationDuration={1400} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {/* Segments donut */}
            <Card className="col-span-12 sm:col-span-5">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Revenue mix
              </div>
              <div className="mt-1 flex items-center gap-3">
                <div className="h-[110px] w-[110px]">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie
                        data={segments}
                        innerRadius={32}
                        outerRadius={50}
                        paddingAngle={3}
                        dataKey="value"
                        stroke="none"
                        animationDuration={1600}
                      >
                        {segments.map((_, i) => (
                          <Cell key={i} fill={segColors[i % segColors.length]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="space-y-1.5 text-[11px]">
                  {segments.map((s, i) => (
                    <li key={s.name} className="flex items-center gap-2 text-muted-foreground">
                      <span
                        className="h-2 w-2 rounded-sm"
                        style={{ background: segColors[i % segColors.length] }}
                      />
                      <span className="text-foreground">{s.name}</span>
                      <span className="ml-auto tabular-nums">{s.value}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>

            {/* Insight strip */}
            <Card className="col-span-12 flex items-start gap-3 bg-gradient-to-br from-primary/10 to-transparent">
              <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="text-[12px] leading-relaxed text-foreground/90">
                <span className="font-medium">Insight.</span>{" "}
                SaaS revenue grew 22% QoQ, while services margin compressed 3.1pts on
                onboarding overhead. Suggest reallocating $48K of CS spend to AE coverage in EMEA.
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Floating chip — sync status */}
      <div className="absolute -left-3 top-24 hidden rotate-[-3deg] rounded-xl border border-border/60 bg-card/90 p-2.5 shadow-xl backdrop-blur-xl animate-float md:block">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary/15 text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
          </span>
          <div>
            <div className="font-medium text-foreground">Xero · Acme UK</div>
            <div className="text-muted-foreground">Synced 12s ago</div>
          </div>
        </div>
      </div>

      <div
        className="absolute -right-4 bottom-16 hidden rotate-[3deg] rounded-xl border border-border/60 bg-card/90 p-2.5 shadow-xl backdrop-blur-xl animate-float md:block"
        style={{ animationDelay: "1.2s" }}
      >
        <div className="flex items-center gap-2 text-[11px]">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-accent/20 text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />
          </span>
          <div>
            <div className="font-medium text-foreground">QuickBooks · Acme US</div>
            <div className="text-muted-foreground">Live · streaming</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-background/40 p-3 backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-sm bg-[oklch(var(--chart-1))]" /> Actual
      </span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-sm bg-muted-foreground/40" /> Plan
      </span>
    </div>
  )
}

function KpiTile({
  icon,
  label,
  value,
  delta,
  positive,
}: {
  icon: React.ReactNode
  label: string
  value: string
  delta: string
  positive?: boolean
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3 backdrop-blur">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="font-serif text-xl tabular-nums">{value}</span>
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            positive ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive",
          )}
        >
          {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
          {delta}
        </span>
      </div>
    </div>
  )
}
