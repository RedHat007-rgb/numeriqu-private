"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Surface } from "../../../components/ui/Surface";
import { Field } from "../../../components/ui/Field";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ThemeToggle } from "../../../components/ui/ThemeToggle";
import { getSupabaseClient } from "../../../lib/supabase";

export function AuthPanel({ onDevToken }: { onDevToken: (token: string) => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const supabase = mounted ? getSupabaseClient() : null;
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [status, setStatus] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  async function sendMagicLink() {
    if (!supabase || !email) return;
    setSending(true);
    setStatus({ tone: "info", text: "Sending magic link..." });
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setSending(false);
    setStatus(
      error
        ? { tone: "danger", text: error.message ?? "We could not send the magic link." }
        : { tone: "info", text: "Magic link sent. Check your inbox." },
    );
  }

  return (
    <main className="relative min-h-screen bg-hero-luxury px-6 py-16 text-text-primary">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-xs text-text-muted hover:text-text-primary">
          ← Back to landing
        </Link>

        <Surface className="mt-8 space-y-6 p-8">
          <header className="space-y-2">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent-blue">
              Secure gateway
            </p>
            <h1 className="text-3xl font-bold text-text-primary">Sign in to your workspace</h1>
            <p className="text-sm text-text-muted">
              Numeriqu is protected with Supabase JWTs. Sign in with your account, or
              receive a one-tap magic link below.
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

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={() => router.push("/login")} className="flex-1">
              Sign in with password
            </Button>
            <Button variant="secondary" onClick={() => router.push("/signup")} className="flex-1">
              Create account
            </Button>
          </div>

          {!mounted ? (
            <div className="h-12 rounded-xl bg-surface-card/40" aria-busy="true" />
          ) : supabase ? (
            <div className="space-y-3 rounded-2xl border border-default bg-surface-card/30 p-5">
              <p className="text-sm font-medium text-text-secondary">
                Or get a one-time magic link
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex-1">
                  <Field
                    label="Work email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                  />
                </div>
                <Button
                  className="self-end"
                  onClick={sendMagicLink}
                  loading={sending}
                  disabled={!email}
                >
                  Send magic link
                </Button>
              </div>
            </div>
          ) : (
            <ErrorBanner tone="warning" title="Auth not configured">
              Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
              <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to your environment to enable
              hosted authentication.
            </ErrorBanner>
          )}

          <details className="group rounded-2xl border border-default bg-surface-card/30 p-4 text-sm text-text-secondary">
            <summary className="cursor-pointer text-text-muted">
              Developer access (paste a Supabase access token)
            </summary>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <Field
                  label="Bearer token"
                  type="text"
                  value={manualToken}
                  onChange={(event) => setManualToken(event.target.value)}
                  placeholder="Paste Supabase access token"
                />
              </div>
              <Button
                variant="secondary"
                className="self-end"
                onClick={() => onDevToken(manualToken.trim())}
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
