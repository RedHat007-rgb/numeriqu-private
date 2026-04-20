import type { ReactNode } from "react";
import { DashboardLayoutClient } from "./_components/DashboardLayoutClient";

export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}

