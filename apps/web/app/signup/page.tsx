"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MailCheck, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { getApiBaseURL } from "../../lib/api/base";
import { Surface } from "../../components/ui/Surface";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ThemeToggle } from "../../components/ui/ThemeToggle";

type Step = "email" | "otp";
type AccountType = "SOLO" | "ORGANIZATION";

type FormErrors = {
  email?: string;
  otp?: string;
  global?: string;
};

const RESEND_COOLDOWN_SECONDS = 30;

function normalizeOtp(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

function mapAuthError(status: number, fallback: string) {
  if (status === 400) return "The code is invalid or expired. Request a new OTP and try again.";
  if (status === 401) return "Your session is no longer valid. Please sign in again.";
  if (status === 403) return "You don't have access to this organization yet.";
  if (status === 429) return "Too many attempts. Wait a moment and retry.";
  if (status >= 500) return "We're having trouble completing signup right now. Please retry shortly.";
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

export default function SignupPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("ORGANIZATION");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [resendIn, setResendIn] = useState(0);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = new URLSearchParams(window.location.search).get("inviteToken");
    setInviteToken(token);
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const isEmailValid = useMemo(() => /.+@.+\..+/.test(email), [email]);

  async function callSendOtp(endpoint: "send-otp" | "resend-otp") {
    const response = await fetch(`${getApiBaseURL()}/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      credentials: "include",
    });
    await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(mapAuthError(response.status, "We could not send the verification code."));
    }
  }

  const handleSendOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});

    if (!isEmailValid) {
      setErrors({ email: "Enter a valid email." });
      return;
    }

    setLoading(true);
    try {
      await callSendOtp("send-otp");
      setStep("otp");
      setOtp("");
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("Verification code sent.");
    } catch (caught) {
      setErrors({
        global: caught instanceof Error ? caught.message : "Unable to send OTP.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0 || loading) return;
    setLoading(true);
    setErrors({});
    try {
      await callSendOtp("resend-otp");
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("OTP sent again.");
    } catch (caught) {
      setErrors({
        global: caught instanceof Error ? caught.message : "Unable to resend OTP.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});

    const normalized = normalizeOtp(otp);
    if (normalized.length !== 6) {
      setErrors({ otp: "Enter the 6-digit OTP." });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${getApiBaseURL()}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: normalized, accountType }),
        credentials: "include",
      });
      await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(mapAuthError(response.status, "OTP verification failed."));
      }

      if (inviteToken) {
        const acceptResponse = await fetch(`${getApiBaseURL()}/organizations/invites/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: inviteToken }),
          credentials: "include",
        });
        if (!acceptResponse.ok) {
          throw new Error(
            mapAuthError(
              acceptResponse.status,
              "Your account was created, but this invite could not be accepted.",
            ),
          );
        }
      }

      toast.success(inviteToken ? "You joined the organization." : "You are signed in.");
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setErrors({
        global: caught instanceof Error ? caught.message : "OTP verification failed.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen bg-hero-luxury px-6 py-10 text-text-primary">
      <div className="mx-auto flex max-w-6xl items-center justify-between pb-10">
        <Link href="/" className="font-display text-xl font-bold text-text-primary">
          Numeriqu
        </Link>
        <ThemeToggle />
      </div>

      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_460px]">
        <Surface className="space-y-5 p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Create account</p>
          <h1 className="text-4xl font-bold leading-tight text-text-primary md:text-5xl">
            Start your finance operating system.
          </h1>
          <p className="max-w-xl text-sm text-text-secondary">
            OTP verification keeps onboarding fast and secure. After verification, we provision your
            workspace context in backend and open your dashboard.
          </p>

          <div className="grid gap-3 pt-2 sm:grid-cols-2">
            <div className="rounded-xl border border-default bg-bg-elevated/40 p-4 text-sm text-text-secondary">
              <Users className="mb-2 size-5 text-accent-blue" />
              Organization mode supports invites, permissions, and messaging.
            </div>
            <div className="rounded-xl border border-default bg-bg-elevated/40 p-4 text-sm text-text-secondary">
              <ShieldCheck className="mb-2 size-5 text-accent-blue" />
              Solo mode removes collaboration surfaces and keeps private ownership.
            </div>
          </div>
        </Surface>

        <Surface className="space-y-6 p-8">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono uppercase tracking-[0.2em] text-text-muted">
              {step === "email" ? "Create account" : "Verify OTP"}
            </span>
            <Link href="/" className="text-text-muted transition-colors hover:text-text-primary">
              Back to landing
            </Link>
          </div>

          <header className="space-y-2">
            <h2 className="text-3xl font-bold text-text-primary">
              {step === "email" ? "Enter your work email" : "Verify email"}
            </h2>
            <p className="text-sm text-text-muted">
              {step === "email"
                ? "We'll send a one-time verification code to continue."
                : `We sent a 6-digit code to ${email}.`}
            </p>
            {inviteToken ? (
              <p className="rounded-lg border border-accent-blue/30 bg-accent-blue/10 px-3 py-2 text-xs text-accent-blue">
                Invite detected. We will add you to that organization after verification.
              </p>
            ) : null}
          </header>

          {errors.global ? <ErrorBanner title="Authentication failed">{errors.global}</ErrorBanner> : null}

          {step === "email" ? (
            <form onSubmit={handleSendOtp} className="space-y-5" noValidate>
              <Field
                label="Work email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                error={errors.email}
                trailing={<MailCheck className="size-4" />}
              />
              {inviteToken ? null : (
                <div className="space-y-2">
                  <p className="block text-sm font-medium text-text-secondary">Account type</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="rounded-xl border border-default bg-bg-elevated/40 p-3 text-sm transition-colors hover:border-strong">
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="accountType"
                          value="SOLO"
                          checked={accountType === "SOLO"}
                          onChange={() => setAccountType("SOLO")}
                        />
                        <span className="font-medium text-text-primary">Solo</span>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        Personal workspace. No invites or messaging.
                      </p>
                    </label>
                    <label className="rounded-xl border border-default bg-bg-elevated/40 p-3 text-sm transition-colors hover:border-strong">
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="accountType"
                          value="ORGANIZATION"
                          checked={accountType === "ORGANIZATION"}
                          onChange={() => setAccountType("ORGANIZATION")}
                        />
                        <span className="font-medium text-text-primary">Organization</span>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        Team workspace with role-based access and chat.
                      </p>
                    </label>
                  </div>
                </div>
              )}
              <Button type="submit" className="w-full" loading={loading}>
                {loading ? "Sending OTP..." : "Send OTP"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-5" noValidate>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-secondary">Verification code</label>
                <OtpBoxes value={otp} onChange={(next) => setOtp(normalizeOtp(next))} />
                {errors.otp ? <p className="text-sm text-feedback-danger">{errors.otp}</p> : null}
              </div>

              <Button type="submit" className="w-full" loading={loading}>
                {loading ? "Verifying..." : "Verify OTP"}
              </Button>

              <div className="flex items-center justify-between text-sm text-text-muted">
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setErrors({});
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
            Already have access?{" "}
            <Link href="/login" className="font-medium text-accent-blue hover:underline">
              Sign in
            </Link>
          </div>
        </Surface>
      </div>
    </main>
  );
}
