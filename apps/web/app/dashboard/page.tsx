"use client";

import React from "react";
import { OverviewPage } from "./_pages/OverviewPage";
import { Navbar, Footer } from "@repo/ui";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-[#050714] text-white">
      <Navbar />
      
      <main className="pt-28 pb-12 px-6 max-w-[1600px] mx-auto">
        <OverviewPage />
      </main>

      <Footer />
    </div>
  );
}
