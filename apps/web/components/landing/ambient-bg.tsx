export function AmbientBg() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Warm paper warmth - saffron tint, soft */}
      <div
        className="absolute -top-56 left-1/2 h-[680px] w-[1180px] -translate-x-1/2 rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.70 0.15 55 / 0.18), transparent 70%)",
        }}
      />
      {/* Forest-teal tint, deeper, anchors the page */}
      <div
        className="absolute -bottom-40 right-0 h-[460px] w-[680px] rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.36 0.07 175 / 0.14), transparent 70%)",
        }}
      />
      {/* Engraved ledger grid */}
      <div className="nq-grid nq-radial-fade animate-grid-pan absolute inset-0 opacity-70" />
      {/* Paper grain */}
      <div className="nq-grain absolute inset-0 opacity-60" />
      {/* Bottom paper fade */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
    </div>
  )
}
