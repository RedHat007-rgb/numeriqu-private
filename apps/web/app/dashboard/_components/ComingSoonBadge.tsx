import { cn } from "../../../components/ui/cn";

/**
 * Sidebar "Coming soon" marker for nav items whose feature is still locked.
 *
 * Data-driven from `comingSoon` on NAV_ITEMS (DashboardShell) rather than a
 * per-label special case, so every locked surface reads the same. The expanded
 * form is a pill beside the label; the collapsed rail has no room for text, so
 * it degrades to a corner dot with the same accent.
 */
export function ComingSoonBadge({
  collapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}) {
  if (collapsed) {
    return (
      <span
        aria-hidden
        title="Coming soon"
        className={cn(
          "absolute right-1 top-1 size-2 rounded-full bg-accent-cyan ring-2 ring-bg-base",
          className,
        )}
      />
    );
  }

  return (
    <span
      className={cn(
        "absolute right-2 top-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5",
        "bg-accent-cyan/12 text-[8px] font-bold uppercase leading-none tracking-[0.14em]",
        "text-accent-cyan ring-1 ring-accent-cyan/30",
        className,
      )}
    >
      Coming soon
    </span>
  );
}
