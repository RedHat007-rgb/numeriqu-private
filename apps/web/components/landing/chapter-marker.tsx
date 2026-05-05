import { cn } from "@/lib/utils"

interface Props {
  numeral: string
  label: string
  className?: string
}

export function ChapterMarker({ numeral, label, className }: Props) {
  return (
    <div className={cn("flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground", className)}>
      <span className="text-primary">{numeral}</span>
      <span aria-hidden className="h-px w-8 bg-border" />
      <span>{label}</span>
    </div>
  )
}
