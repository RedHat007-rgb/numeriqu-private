export const dynamic = "force-dynamic";

export default function NewDashboardPage() {
  return (
    <section
      className="h-[calc(100vh-118px)] min-h-[720px] overflow-hidden rounded-2xl border border-accent-blue/20 bg-bg-base shadow-[0_24px_70px_-40px_rgba(0,119,255,0.55)]"
      aria-label="New Dashboard workspace"
    >
      <iframe
        className="h-full w-full border-0 bg-bg-base"
        src="/new-dashboard/index.html"
        title="New Dashboard — CFO Insights Command Center"
      >
        Your browser does not support embedded dashboards.
      </iframe>
    </section>
  );
}
