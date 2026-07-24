"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardResponse } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

type DashboardMessage =
  | { type: "numeriq:dashboard-ready" }
  | { type: "numeriq:dashboard-data"; payload: DashboardResponse };

export default function NewDashboardFrame() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { analytics, loading } = useNumeriquApi();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);

  useEffect(() => {
    if (loading) return;
    let active = true;

    void analytics
      .dashboard({ kind: "ALL_TIME" })
      .then((payload) => {
        if (active) setDashboard(payload);
      })
      .catch(() => {
        // The embedded workbook data remains available when live analytics is offline.
      });

    return () => {
      active = false;
    };
  }, [analytics, loading]);

  const sendDashboard = useCallback(() => {
    if (!dashboard || !iframeRef.current?.contentWindow) return;
    const message: DashboardMessage = {
      type: "numeriq:dashboard-data",
      payload: dashboard,
    };
    iframeRef.current.contentWindow.postMessage(message, window.location.origin);
  }, [dashboard]);

  useEffect(() => {
    sendDashboard();
  }, [sendDashboard]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<DashboardMessage>) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "numeriq:dashboard-ready") sendDashboard();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendDashboard]);

  return (
    <iframe
      ref={iframeRef}
      className="h-full w-full border-0 bg-bg-base"
      src="/new-dashboard/index.html"
      title="New Dashboard — CFO Insights Command Center"
      onLoad={sendDashboard}
    >
      Your browser does not support embedded dashboards.
    </iframe>
  );
}
