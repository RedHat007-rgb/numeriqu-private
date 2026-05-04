import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "danger" | "warning" | "info";

const toneStyles: Record<Tone, string> = {
  danger:
    "border-feedback-danger/30 bg-feedback-danger/10 text-feedback-danger",
  warning:
    "border-feedback-warning/30 bg-feedback-warning/10 text-feedback-warning",
  info: "border-feedback-info/30 bg-feedback-info/10 text-feedback-info",
};

type ErrorBannerProps = {
  title?: string;
  children: ReactNode;
  tone?: Tone;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
};

export function ErrorBanner({
  title,
  children,
  tone = "danger",
  action,
  onDismiss,
  className,
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-2xl border p-4",
        toneStyles[tone],
        className,
      )}
    >
      <div className="flex-1">
        {title ? (
          <p className="font-medium text-text-primary">{title}</p>
        ) : null}
        <div className="mt-1 text-sm">{children}</div>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full px-2 py-1 text-xs text-text-muted hover:text-text-primary"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
