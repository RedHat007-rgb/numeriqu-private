import { SignalDetailPage } from "../../_pages/SignalDetailPage";

export const dynamic = "force-dynamic";

export default async function SignalRoute({
  params,
}: {
  params: Promise<{ signalId: string }>;
}) {
  const { signalId } = await params;
  return <SignalDetailPage signalId={signalId} />;
}
