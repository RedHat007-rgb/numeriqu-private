import { SignalDetailPage } from "../../_pages/SignalDetailPage";
import { SignalsComingSoon } from "../../_components/SignalsComingSoon";
import { SIGNALS_LOCKED } from "../../_lib/featureLocks";

export const dynamic = "force-dynamic";

export default async function SignalRoute({
  params,
}: {
  params: Promise<{ signalId: string }>;
}) {
  // Deep links must respect the same lock as the inbox, otherwise a bookmarked
  // signal URL walks straight past the coming-soon page.
  if (SIGNALS_LOCKED) return <SignalsComingSoon />;

  const { signalId } = await params;
  return <SignalDetailPage signalId={signalId} />;
}
