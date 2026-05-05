"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Surface } from "../../../components/ui/Surface";
import { Button } from "../../../components/ui/Button";
import { useAuth } from "../../providers";
import { getInviteDetails } from "../../../lib/api/integrations";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import type { InviteDetails } from "../../../lib/api";

type PageState = "loading" | "ready" | "expired" | "accepted" | "error";

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { supabase, user: authedUser } = useAuth();
  const { integrations } = useNumeriquApi();

  const token = params.token;
  const connectionId = searchParams.get("org") ?? "";

  const [pageState, setPageState] = useState<PageState>("loading");
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load invite details (public, no auth needed)
  useEffect(() => {
    if (!token) return;
    getInviteDetails(token)
      .then((details) => {
        setInvite(details);
        setPageState(details.expired ? "expired" : "ready");
      })
      .catch(() => setPageState("error"));
  }, [token]);

  const handleAccept = async () => {
    if (!authedUser) {
      // Not logged in — redirect to login then come back
      const returnUrl = encodeURIComponent(`/invite/${token}?org=${connectionId}`);
      router.push(`/login?next=${returnUrl}`);
      return;
    }

    setAccepting(true);
    setError(null);
    try {
      const result = await integrations.acceptInvite(token, connectionId);
      toast.success(`You've joined ${result.orgName}!`);
      setPageState("accepted");
      setTimeout(() => router.push("/dashboard/integrations"), 2000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to accept invite.");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-bg-base px-6 py-16 text-text-primary">
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grid opacity-25" />
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grain opacity-55" />

      <div className="relative w-full max-w-md">
        <div className="mb-6 flex items-center justify-between text-xs">
          <Link href="/" className="text-text-muted transition-colors hover:text-text-primary">
            ← Home
          </Link>
          <span className="font-mono uppercase tracking-[0.24em] text-text-muted">Invitation</span>
        </div>

        <Surface className="space-y-6 p-8">
          {pageState === "loading" && (
            <div className="space-y-3">
              <div className="h-8 w-2/3 animate-pulse rounded-xl bg-surface-card" />
              <div className="h-4 w-full animate-pulse rounded-lg bg-surface-card" />
              <div className="h-4 w-4/5 animate-pulse rounded-lg bg-surface-card" />
            </div>
          )}

          {pageState === "expired" && (
            <>
              <header className="space-y-2">
                <div className="text-3xl">⏱</div>
                <h1 className="text-2xl font-bold text-text-primary">Invite expired</h1>
                <p className="text-sm text-text-muted">
                  This invitation link has expired or has already been used. Ask the owner to send a new one.
                </p>
              </header>
              <Link href="/dashboard">
                <Button className="w-full">Go to dashboard</Button>
              </Link>
            </>
          )}

          {pageState === "error" && (
            <>
              <header className="space-y-2">
                <h1 className="text-2xl font-bold text-text-primary">Invite not found</h1>
                <p className="text-sm text-text-muted">
                  This link is invalid or has already been used.
                </p>
              </header>
              <Link href="/">
                <Button variant="secondary" className="w-full">Go home</Button>
              </Link>
            </>
          )}

          {pageState === "accepted" && (
            <>
              <header className="space-y-2">
                <div className="text-3xl">🎉</div>
                <h1 className="text-2xl font-bold text-text-primary">You're in!</h1>
                <p className="text-sm text-text-muted">
                  You've joined <strong className="text-text-primary">{invite?.orgName}</strong>.
                  Redirecting to your dashboard…
                </p>
              </header>
            </>
          )}

          {pageState === "ready" && invite && (
            <>
              <header className="space-y-2">
                <h1 className="text-2xl font-bold text-text-primary">You're invited</h1>
                <p className="text-sm text-text-muted">
                  You've been invited to join{" "}
                  <strong className="text-text-primary">{invite.orgName}</strong> on NumeriQ as a{" "}
                  <span className="capitalize text-text-primary">{invite.role}</span>.
                </p>
              </header>

              {error && (
                <div className="rounded-xl border border-feedback-danger/30 bg-feedback-danger/10 px-4 py-3 text-sm text-feedback-danger">
                  {error}
                </div>
              )}

              {!authedUser ? (
                <div className="space-y-3">
                  <p className="text-sm text-text-muted">
                    You need to sign in (or create a free account) before accepting.
                    The invite is locked to <strong className="text-text-primary">{invite.email}</strong>.
                  </p>
                  <Button className="w-full" onClick={handleAccept}>
                    Sign in to accept
                  </Button>
                  <div className="text-center text-xs text-text-muted">
                    Don't have an account?{" "}
                    <Link
                      href={`/signup?email=${encodeURIComponent(invite.email)}&next=${encodeURIComponent(`/invite/${token}?org=${connectionId}`)}`}
                      className="text-accent-blue hover:underline"
                    >
                      Create one free
                    </Link>
                  </div>
                </div>
              ) : (
                <Button className="w-full" onClick={handleAccept} loading={accepting}>
                  {accepting ? "Joining…" : `Accept & join ${invite.orgName}`}
                </Button>
              )}
            </>
          )}
        </Surface>
      </div>
    </main>
  );
}
