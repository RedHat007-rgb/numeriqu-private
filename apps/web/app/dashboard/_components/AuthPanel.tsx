"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Surface } from "../../../components/ui/Surface";
import { Field } from "../../../components/ui/Field";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";

export function AuthPanel({
  onDevToken,
  error,
}: {
  onDevToken: (token: string) => void;
  error?: string | null;
}) {
  const router = useRouter();
  const [manualToken, setManualToken] = useState("");
  const [status, setStatus] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [dismissedError, setDismissedError] = useState(false);

  useEffect(() => {
    setDismissedError(false);
  }, [error]);

  return (
    <main className="relative min-h-screen bg-bg-base px-6 py-16 text-text-primary">
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grid opacity-25" />
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grain opacity-55" />

      <div className="relative mx-auto max-w-2xl">
        <Surface className="space-y-6 p-8">
          <header className="space-y-2">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent-blue">
              Secure gateway
            </p>
            <h1 className="text-3xl font-bold text-text-primary">Sign in to your workspace</h1>
            <p className="text-sm text-text-muted">
              NumeriQ uses backend-managed session tokens with OTP verification.
            </p>
          </header>

          {status ? (
            <ErrorBanner
              tone={status.tone === "danger" ? "danger" : "info"}
              onDismiss={() => setStatus(null)}
            >
              {status.text}
            </ErrorBanner>
          ) : null}
          {!status && error && !dismissedError ? (
            <ErrorBanner tone="danger" onDismiss={() => setDismissedError(true)}>
              {error}
            </ErrorBanner>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={() => router.push("/login")} className="flex-1">
              Sign in with OTP
            </Button>
            <Button variant="secondary" onClick={() => router.push("/signup")} className="flex-1">
              Create account
            </Button>
          </div>

          <details className="group rounded-2xl border border-default bg-surface-card/30 p-4 text-sm text-text-secondary">
            <summary className="cursor-pointer text-text-muted">Developer access token</summary>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <Field
                  label="Bearer token"
                  type="text"
                  value={manualToken}
                  onChange={(event) => setManualToken(event.target.value)}
                  placeholder="Paste backend-issued access token"
                />
              </div>
              <Button
                variant="secondary"
                className="self-end"
                onClick={() => {
                  const token = manualToken.trim();
                  if (!token) {
                    setStatus({ tone: "danger", text: "Token cannot be empty." });
                    return;
                  }
                  onDevToken(token);
                  setStatus({ tone: "info", text: "Token applied for this browser." });
                }}
                disabled={!manualToken.trim()}
              >
                Use token
              </Button>
            </div>
          </details>
        </Surface>
      </div>
    </main>
  );
}
