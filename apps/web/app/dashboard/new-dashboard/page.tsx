import NewDashboardFrame from "./NewDashboardFrame";

export const dynamic = "force-dynamic";

export default function NewDashboardPage() {
  return (
    <section
      className="h-[calc(100vh-118px)] min-h-[720px] overflow-hidden rounded-2xl border border-accent-blue/20 bg-transparent shadow-[0_24px_70px_-40px_rgba(0,119,255,0.55)]"
      aria-label="New Dashboard workspace"
    >
      <NewDashboardFrame />
    </section>
  );
}
