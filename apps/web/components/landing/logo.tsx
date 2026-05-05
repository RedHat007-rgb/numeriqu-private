import { cn } from "@/lib/utils"

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-7 w-7", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="nq-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.82 0.16 165)" />
          <stop offset="1" stopColor="oklch(0.62 0.14 175)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="oklch(0.17 0.012 75)" stroke="oklch(0.26 0.012 75)" />
      <path
        d="M9 22V10l7 9V10M22 22v-6"
        stroke="url(#nq-logo)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="22" cy="11.5" r="1.6" fill="url(#nq-logo)" />
    </svg>
  )
}
