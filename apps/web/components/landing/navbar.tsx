"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Logo } from "./logo"
import { cn } from "@/lib/utils"

const links = [
  { label: "Product", href: "#one-brain" },
  { label: "How it thinks", href: "#two-minds" },
  { label: "Architecture", href: "#architecture" },
  { label: "Trust", href: "#trust" },
]

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-500",
        scrolled ? "py-2" : "py-4",
      )}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <nav
          className={cn(
            "flex items-center justify-between rounded-full border px-4 py-2.5 transition-all duration-500",
            scrolled
              ? "border-border/70 bg-background/70 shadow-[0_8px_40px_-12px_oklch(0_0_0/0.5)] backdrop-blur-xl"
              : "border-transparent bg-transparent",
          )}
        >
          <Link href="/" aria-label="NumeriQu home" className="inline-flex items-center">
            <Logo className="h-9 w-auto" />
          </Link>

          <ul className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="rounded-full px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2">
            <a
              href="/login"
              className="hidden rounded-full px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              Sign in
            </a>
            <a
              href="/signup"
              className="group inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground shadow-[0_8px_30px_-8px_oklch(0.72_0.14_165/0.6)] transition-all hover:bg-primary/90"
            >
              Open the brain
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
            </a>
          </div>
        </nav>
      </div>
    </header>
  )
}
