import { Suspense } from "react";
import { AgentWorkbench } from "../_components/AgentWorkbench";

export default function AgentPage() {
  return (
    <Suspense>
      <AgentWorkbench />
    </Suspense>
  );
}
