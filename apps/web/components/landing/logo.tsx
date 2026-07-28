import { cn } from "@/lib/utils"

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-10 w-auto", className)}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="numeriqu-logo-gradient" x1="16" y1="20" x2="104" y2="108" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1992FF" />
          <stop offset="1" stopColor="#B45AF7" />
        </linearGradient>
      </defs>
      <g transform="translate(16 16)">
        <circle
          cx="48"
          cy="48"
          r="32"
          stroke="url(#numeriqu-logo-gradient)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray="165 40"
          transform="rotate(36 48 48)"
        />
        <path
          d="M56.5 57.5L82 83"
          stroke="url(#numeriqu-logo-gradient)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <text
        x="140"
        y="82"
        fill="#FFFFFF"
        fontFamily="var(--font-nunito), var(--font-roboto), Inter, ui-sans-serif, system-ui, sans-serif"
        fontSize="56"
        fontWeight="800"
        letterSpacing="1.2"
      >
        NumeriQu
      </text>
    </svg>
  )
}
