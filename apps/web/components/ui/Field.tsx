import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
  trailing?: ReactNode;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, trailing, className, id, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? `field-${reactId}`;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          {...rest}
          className={cn(
            "w-full rounded-xl border bg-surface-card/70 px-4 py-2.5 text-text-primary placeholder:text-text-muted",
            "outline-none transition-colors",
            "border-default focus:border-accent-blue/60",
            error ? "border-feedback-danger/60 focus:border-feedback-danger" : null,
            trailing ? "pr-10" : null,
            className,
          )}
        />
        {trailing ? (
          <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted">
            {trailing}
          </div>
        ) : null}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-xs text-feedback-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
