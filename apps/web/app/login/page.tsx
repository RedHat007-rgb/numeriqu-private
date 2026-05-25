"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MailCheck, ShieldCheck, Timer, Workflow } from "lucide-react";
import { toast } from "sonner";
import { getApiBaseURL } from "../../lib/api/base";
import { Surface } from "../../components/ui/Surface";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { ErrorBanner } from "../../components/ui/ErrorBanner";

type Step = "email" | "otp";

const RESEND_COOLDOWN_SECONDS = 30;

/** Emails that bypass OTP and go straight to the shared demo org */
const DEMO_EMAIL_RE = /^demo[1-5]@numeriqu\.com$/;

function normalizeOtp(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

function mapAuthError(status: number, fallback: string) {
  if (status === 400) return "The code is invalid or expired. Request a new OTP and try again.";
  if (status === 401) return "Your session is no longer valid. Please sign in again.";
  if (status === 403) return "You don't have access to this workspace yet.";
  if (status === 429) return "Too many attempts. Wait a moment and retry.";
  if (status >= 500) return "We're having trouble completing sign-in right now. Please retry shortly.";
  return fallback;
}

function OtpBoxes({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  return (
    <div className="flex items-center justify-between gap-2">
      {Array.from({ length: 6 }).map((_, idx) => (
        <input
          key={idx}
          ref={(node) => {
            refs.current[idx] = node;
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          value={value[idx] ?? ""}
          onPaste={(event) => {
            const pasted = normalizeOtp(event.clipboardData.getData("text"));
            if (pasted.length) {
              event.preventDefault();
              onChange(pasted);
            }
          }}
          onChange={(event) => {
            const digit = event.target.value.replace(/\D/g, "").slice(0, 1);
            const next = value.split("");
            next[idx] = digit;
            onChange(next.join("").slice(0, 6));
            if (digit && idx < 5) refs.current[idx + 1]?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !value[idx] && idx > 0) {
              refs.current[idx - 1]?.focus();
            }
          }}
          className="h-12 w-11 rounded-xl border border-default bg-bg-surface text-center text-xl font-semibold text-text-primary outline-none ring-offset-2 transition focus:border-accent-blue focus:ring-2 focus:ring-accent-blue/40"
          aria-label={`OTP digit ${idx + 1}`}
        />
      ))}
    </div>
  );
}

export default function LoginPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const router = useRouter();

  const isDemo = DEMO_EMAIL_RE.test(email.trim().toLowerCase());

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function sendOtp(endpoint: "send-otp" | "resend-otp") {
    const response = await fetch(`${getApiBaseURL()}/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      credentials: "include",
    });

    await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(mapAuthError(response.status, "Unable to send a verification code."));
    }
  }

  async function handleSendOtp(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();

    if (!/.+@.+\..+/.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }

    // ── Demo accounts: skip OTP entirely ──────────────────────────────────────
    if (DEMO_EMAIL_RE.test(trimmed)) {
      setLoading(true);
      try {
        const res = await fetch(`${getApiBaseURL()}/auth/demo-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
          credentials: "include",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            (json as any)?.message ?? mapAuthError(res.status, "Demo login failed.")
          );
        }
        toast.success("Signed in as demo account.");
        router.push("/dashboard");
        router.refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Demo login failed.");
      } finally {
        setLoading(false);
      }
      return;
    }

    // ── Normal OTP flow ───────────────────────────────────────────────────────
    setLoading(true);
    try {
      await sendOtp("send-otp");
      setStep("otp");
      setOtp("");
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("OTP sent.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to send OTP.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const normalized = normalizeOtp(otp);
    if (normalized.length !== 6) {
      setError("Enter the 6-digit OTP.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${getApiBaseURL()}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: normalized }),
        credentials: "include",
      });

      await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(mapAuthError(response.status, "OTP verification failed."));
      }

      toast.success("Signed in successfully.");
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OTP verification failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendIn > 0 || loading) return;
    setLoading(true);
    setError(null);

    try {
      await sendOtp("resend-otp");
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("OTP sent again.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to resend OTP.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-bg-base px-6 py-10 text-text-primary">
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grid opacity-25" />
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grain opacity-55" />

      <div className="relative mx-auto flex max-w-6xl items-center justify-between pb-10">
        <Link href="/" className="font-serif text-xl font-semibold tracking-tight text-text-primary">
          NumeriQ
        </Link>
      </div>

      <div className="relative mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_420px] lg:items-stretch">
        <Surface className="space-y-5 p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Welcome back</p>
          <h1 className="text-4xl font-bold leading-tight text-text-primary md:text-5xl">
            Get back to what changed in your finances.
          </h1>
          <p className="max-w-xl text-sm text-text-secondary">
            We verify access with one-time codes only. No magic links, no hidden auth paths.
            Sessions are backend-controlled and organization scoped.
          </p>

          <div className="grid gap-3 pt-2 sm:grid-cols-3">
            <div className="rounded-xl border border-default bg-bg-elevated/40 p-4 text-sm text-text-secondary">
              <ShieldCheck className="mb-2 size-5 text-accent-blue" />
              Security-first auth
            </div>
            <div className="rounded-xl border border-default bg-bg-elevated/40 p-4 text-sm text-text-secondary">
              <Workflow className="mb-2 size-5 text-accent-blue" />
              Backend source of truth
            </div>
            <div className="rounded-xl border border-default bg-bg-elevated/40 p-4 text-sm text-text-secondary">
              <Timer className="mb-2 size-5 text-accent-blue" />
              5-minute OTP lifetime
            </div>
          </div>
        </Surface>

        <Surface className="space-y-6 p-8">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono uppercase tracking-[0.2em] text-text-muted">Sign in</span>
            <Link href="/" className="text-text-muted transition-colors hover:text-text-primary">
              Back to landing
            </Link>
          </div>

          <header className="space-y-2">
            <h2 className="text-3xl font-bold text-text-primary">
              {step === "email" ? "Continue with email" : "Enter your OTP"}
            </h2>
            <p className="text-sm text-text-muted">
              {step === "email"
                ? "Use your work email to receive a secure sign-in code."
                : `We sent a 6-digit code to ${email}.`}
            </p>
          </header>

          {error ? <ErrorBanner title="Sign-in failed">{error}</ErrorBanner> : null}

          {step === "email" ? (
            <form onSubmit={handleSendOtp} className="space-y-5" noValidate>
              <Field
                label="Work email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                trailing={<MailCheck className="size-4" />}
              />

              {/* Demo badge — shows when a demo email is typed */}
              {isDemo && (
                <p className="rounded-lg border border-accent-blue/30 bg-accent-blue/10 px-3 py-2 text-xs text-accent-blue">
                  ✓ Demo account detected — no OTP required, instant access.
                </p>
              )}

              <Button type="submit" className="w-full" loading={loading}>
                {loading
                  ? isDemo ? "Signing in..." : "Sending OTP..."
                  : isDemo ? "Sign in (no OTP)" : "Send OTP"}
              </Button>

              {/* Demo quick-pick */}
              <div className="border-t border-default pt-4">
                <p className="mb-2 text-xs text-text-muted">Or try a demo account (no OTP):</p>
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setEmail(`demo${n}@numeriqu.com`)}
                      className="rounded-lg border border-default bg-bg-elevated/60 px-3 py-1.5 text-xs font-mono text-text-secondary transition-colors hover:border-accent-blue/50 hover:text-accent-blue"
                    >
                      demo{n}
                    </button>
                  ))}
                </div>
              </div>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-5" noValidate>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-secondary">OTP code</label>
                <OtpBoxes value={otp} onChange={(next) => setOtp(normalizeOtp(next))} />
              </div>

              <Button type="submit" className="w-full" loading={loading}>
                {loading ? "Verifying..." : "Verify OTP"}
              </Button>

              <div className="flex items-center justify-between text-sm text-text-muted">
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setError(null);
                    setOtp("");
                  }}
                  className="transition-colors hover:text-text-primary"
                >
                  Change email
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resendIn > 0 || loading}
                  className="transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend OTP"}
                </button>
              </div>
            </form>
          )}

          <div className="border-t border-default pt-5 text-center text-sm text-text-muted">
            New to NumeriQ?{" "}
            <Link href="/signup" className="font-medium text-accent-blue hover:underline">
              Create account
            </Link>
          </div>
        </Surface>
      </div>
    </main>
  );
}
