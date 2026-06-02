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
        <linearGradient id="nq-logo-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0077FF" />
          <stop offset="1" stopColor="#9B4DFF" />
        </linearGradient>
      </defs>
      {/* Background box */}
      <rect x="2" y="2" width="28" height="28" rx="8" fill="#0A1128" stroke="#1a2a5a" strokeWidth="0.5" />
      {/* Magnifying glass circle (the Q) */}
      <circle cx="13.5" cy="13.5" r="6.5" stroke="url(#nq-logo-grad)" strokeWidth="2.2" fill="none" />
      {/* Handle — the Q tail */}
      <line x1="18.1" y1="18.1" x2="24" y2="24" stroke="url(#nq-logo-grad)" strokeWidth="2.2" strokeLinecap="round" />
      {/* Inner power-symbol stroke */}
      <line x1="13.5" y1="10" x2="13.5" y2="15.5" stroke="url(#nq-logo-grad)" strokeWidth="1.8" strokeLinecap="round" opacity="0.65" />
    </svg>
  )
}
