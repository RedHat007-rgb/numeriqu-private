import Link from "next/link"
import { Logo } from "./logo"

const COLS: { title: string; items: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    items: [
      { label: "The unification", href: "#one-brain" },
      { label: "Two minds", href: "#two-minds" },
      { label: "Architecture", href: "#architecture" },
      { label: "Ask the agent", href: "#ask" },
    ],
  },
  {
    title: "Company",
    items: [
      { label: "About", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Press", href: "#" },
      { label: "Contact", href: "#" },
    ],
  },
  {
    title: "Resources",
    items: [
      { label: "Documentation", href: "#" },
      { label: "Changelog", href: "#" },
      { label: "Trust center", href: "#trust" },
      { label: "Status", href: "#" },
    ],
  },
]

export function Footer() {
  return (
    <footer className="relative border-t border-border/60 bg-card/30">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_2fr]">
          <div>
            <Link href="/" className="inline-flex items-center gap-2.5">
              <Logo className="h-7 w-7" />
              <span className="font-serif text-2xl tracking-tight">NumeriQ</span>
            </Link>
            <p className="mt-4 max-w-sm text-[14px] leading-relaxed text-muted-foreground">
              The financial brain for modern finance teams. Unify every ERP.
              Ask anything. Generate dashboards your CFO will actually use.
            </p>
            <div className="mt-6 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
              All systems operational
            </div>
          </div>

          <div className="grid grid-cols-3 gap-8">
            {COLS.map((col) => (
              <div key={col.title}>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {col.title}
                </div>
                <ul className="mt-4 space-y-2.5">
                  {col.items.map((item) => (
                    <li key={item.label}>
                      <Link
                        href={item.href}
                        className="text-[14px] text-foreground/80 transition-colors hover:text-foreground"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="relative mt-16 overflow-hidden">
          <div
            aria-hidden
            className="select-none bg-gradient-to-b from-foreground/10 to-transparent bg-clip-text font-serif text-[clamp(4rem,18vw,16rem)] leading-none tracking-tight text-transparent"
          >
            NumeriQ
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-border/60 pt-6 text-[12px] text-muted-foreground sm:flex-row sm:items-center">
          <div>© {new Date().getFullYear()} NumeriQ, Inc. All rights reserved.</div>
          <div className="flex items-center gap-5">
            <Link href="#" className="hover:text-foreground">Privacy</Link>
            <Link href="#" className="hover:text-foreground">Terms</Link>
            <Link href="#" className="hover:text-foreground">DPA</Link>
            <Link href="#" className="hover:text-foreground">Security</Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
