import NewDashboardFrame from "./new-dashboard/NewDashboardFrame";

export const dynamic = "force-dynamic";

/**
 * The CFO insights command center is the workspace Overview. The previous
 * card-grid overview (`_pages/OverviewPage`) is no longer wired to a route.
 */
export default function DashboardPage() {
  return (
    <section
      className="h-[calc(100vh-118px)] min-h-[720px] overflow-hidden rounded-2xl border border-accent-blue/20 bg-transparent shadow-[0_24px_70px_-40px_rgba(0,119,255,0.55)]"
      aria-label="Overview workspace"
    >
      <NewDashboardFrame />
    </section>
  );
}
