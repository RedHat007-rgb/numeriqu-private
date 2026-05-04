import { cn } from "./cn";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const toneStyles: Record<Tone, string> = {
  success: "bg-feedback-success/10 text-feedback-success ring-feedback-success/20",
  warning: "bg-feedback-warning/10 text-feedback-warning ring-feedback-warning/20",
  danger: "bg-feedback-danger/10 text-feedback-danger ring-feedback-danger/20",
  info: "bg-feedback-info/10 text-feedback-info ring-feedback-info/20",
  neutral: "bg-text-muted/10 text-text-secondary ring-text-muted/15",
};

const toneDot: Record<Tone, string> = {
  success: "bg-feedback-success",
  warning: "bg-feedback-warning",
  danger: "bg-feedback-danger",
  info: "bg-feedback-info",
  neutral: "bg-text-muted",
};

type StatusPillProps = {
  tone?: Tone;
  children: React.ReactNode;
  withDot?: boolean;
  className?: string;
};

export function StatusPill({
  tone = "neutral",
  children,
  withDot = true,
  className,
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1",
        toneStyles[tone],
        className,
      )}
    >
      {withDot ? (
        <span className={cn("h-1.5 w-1.5 rounded-full", toneDot[tone])} />
      ) : null}
      {children}
    </span>
  );
}
