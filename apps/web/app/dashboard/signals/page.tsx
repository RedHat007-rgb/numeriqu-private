"use client";

import { SignalsPage } from "../_pages/SignalsPage";
import { SignalsComingSoon } from "../_components/SignalsComingSoon";
import { SIGNALS_LOCKED } from "../_lib/featureLocks";

export const dynamic = "force-dynamic";

export default function SignalsRoute() {
  // Rendered instead of, not on top of, the real page — a locked feature should
  // not be issuing authenticated signal queries the user can never see.
  if (SIGNALS_LOCKED) return <SignalsComingSoon />;
  return <SignalsPage />;
}
