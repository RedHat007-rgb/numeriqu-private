import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-blue text-white border border-accent-blue shadow-sm hover:-translate-y-0.5 hover:bg-accent-blue/90 hover:shadow-md",
  secondary:
    "border border-default text-text-primary bg-bg-surface hover:border-strong hover:bg-bg-elevated",
  ghost:
    "text-text-primary hover:bg-text-primary/5",
  danger:
    "bg-feedback-danger/12 text-feedback-danger border border-feedback-danger/30 hover:bg-feedback-danger/20",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-5 py-2.5 text-sm",
  lg: "px-6 py-3 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || undefined}
      {...rest}
      disabled={disabled || loading}
      className={cn(baseClasses, variants[variant], sizes[size], className)}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});
