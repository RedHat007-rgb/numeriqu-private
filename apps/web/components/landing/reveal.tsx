"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

interface RevealProps {
  children: React.ReactNode
  className?: string
  delay?: number
  as?: "div" | "span" | "section" | "article"
  y?: number
}

export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = "div",
  y = 24,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true)
            observer.disconnect()
          }
        })
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const Component = Tag as React.ElementType
  return (
    <Component
      ref={ref as React.Ref<HTMLDivElement>}
      style={{
        transitionDelay: `${delay}ms`,
        transform: visible ? "translate3d(0,0,0)" : `translate3d(0, ${y}px, 0)`,
      }}
      className={cn(
        "transition-[opacity,transform] duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
        visible ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {children}
    </Component>
  )
}
