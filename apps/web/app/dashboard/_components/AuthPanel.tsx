"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabaseClient } from "../../../lib/supabase";

function cardClass(extra = "") {
  return `rounded-3xl border border-white/10 bg-slate-950/55 p-6 shadow-2xl shadow-blue-950/20 backdrop-blur-xl ${extra}`;
}

export function AuthPanel({ onDevToken }: { onDevToken: (token: string) => void }) {
  /** Supabase browser client is null during SSR; branching on it here caused hydration mismatches. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const supabase = mounted ? getSupabaseClient() : null;
  const [email, setEmail] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function sendMagicLink() {
    if (!supabase || !email) return;
    setStatus("Sending magic link...");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setStatus(error ? error.message : "Magic link sent. Check your inbox.");
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-white">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-cyan-300 hover:text-cyan-200">
          ← Back to landing
        </Link>
        <div className={cardClass("mt-8")}>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-blue-300">Secure Gateway</p>
          <h1 className="mt-4 font-display text-4xl font-bold">Connect to the backend</h1>
          <p className="mt-4 text-slate-300">
            The API is protected with Supabase JWTs. Sign in here, or paste a bearer token for development.
          </p>

          {!mounted ? (
            <div
              className="mt-8 min-h-[52px] rounded-2xl bg-white/[0.04]"
              aria-busy="true"
              aria-label="Loading sign-in options"
            />
          ) : supabase ? (
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                className="min-h-12 flex-1 rounded-full border border-white/10 bg-slate-900 px-5 text-white outline-none focus:border-blue-400"
              />
              <button
                onClick={sendMagicLink}
                className="rounded-full bg-blue-500 px-6 py-3 font-semibold text-white hover:bg-blue-400"
              >
                Send magic link
              </button>
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
              Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to enable hosted auth.
            </div>
          )}

          <div className="mt-8 border-t border-white/10 pt-8">
            <p className="text-sm font-semibold text-slate-200">Development token override</p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <input
                value={manualToken}
                onChange={(event) => setManualToken(event.target.value)}
                placeholder="Paste Supabase access token"
                className="min-h-12 flex-1 rounded-full border border-white/10 bg-slate-900 px-5 text-white outline-none focus:border-cyan-400"
              />
              <button
                onClick={() => onDevToken(manualToken.trim())}
                disabled={!manualToken.trim()}
                className="rounded-full bg-cyan-500 px-6 py-3 font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-50"
              >
                Use token
              </button>
            </div>
          </div>

          {status ? <p className="mt-5 text-sm text-cyan-200">{status}</p> : null}
        </div>
      </div>
    </main>
  );
}

