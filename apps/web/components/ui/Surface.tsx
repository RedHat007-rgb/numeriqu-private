import { cn } from "./cn";

type SurfaceProps = React.HTMLAttributes<HTMLDivElement> & {
  tone?: "card" | "elevated" | "ghost";
  glow?: "none" | "blue" | "violet";
};

/**
 * Theme-aware surface card. In dark mode it uses the existing glass aesthetic;
 * in light mode it falls back to crisp white surfaces with subtle shadows.
 */
export function Surface({
  className,
  tone = "card",
  glow = "none",
  ...rest
}: SurfaceProps) {
  return (
    <div
      {...rest}
      className={cn(
        "surface-card",
        glow === "blue" && "glow-blue",
        glow === "violet" && "glow-violet",
        tone === "elevated" && "shadow-glass",
        tone === "ghost" && "border-subtle bg-transparent shadow-none",
        "p-6",
        className,
      )}
    />
  );
}
