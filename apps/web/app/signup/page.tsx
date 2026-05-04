"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getApiBaseURL } from "../../lib/api/base";
import { Surface } from "../../components/ui/Surface";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ThemeToggle } from "../../components/ui/ThemeToggle";
import { useAuth } from "../providers";

type Step = "form" | "otp";

type FormErrors = {
  name?: string;
  email?: string;
  password?: string;
  otp?: string;
  global?: string;
};

const RESEND_COOLDOWN_SECONDS = 30;

function passwordStrength(value: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!value) return { score: 0, label: "Enter at least 8 characters" };
  const length = value.length >= 12;
  const variety = /[A-Z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value);
  if (length && variety) return { score: 3, label: "Excellent" };
  if (value.length >= 8 && (/[A-Z]/.test(value) || /[0-9]/.test(value))) return { score: 2, label: "Good" };
  return { score: 1, label: "Add length and a number or symbol" };
}

export default function SignupPage() {
  const [step, setStep] = useState<Step>("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [resendIn, setResendIn] = useState(0);
  const otpRef = useRef<HTMLInputElement | null>(null);
  const { supabase } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (step === "otp") otpRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  function validateForm(): FormErrors {
    const next: FormErrors = {};
    if (!name.trim()) next.name = "Tell us your name so we can personalize your workspace.";
    if (!email) next.email = "Email is required.";
    else if (!/.+@.+\..+/.test(email)) next.email = "Enter a valid email.";
    if (!password) next.password = "Password is required.";
    else if (password.length < 8) next.password = "Use at least 8 characters.";
    return next;
  }

  const handleSendOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    const validation = validateForm();
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }
    if (!supabase) {
      setErrors({
        global:
          "Authentication is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to enable sign-up.",
      });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${getApiBaseURL()}/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.message ?? "We could not send a verification code.");
      }
      setStep("otp");
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("Verification code sent. Check your inbox.");
    } catch (caught) {
      setErrors({
        global: caught instanceof Error ? caught.message : "We could not send a code.",
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
      const response = await fetch(`${getApiBaseURL()}/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message ?? "We could not resend the code.");
      }
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("New verification code sent.");
    } catch (caught) {
      setErrors({
        global: caught instanceof Error ? caught.message : "We could not resend the code.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    if (otp.length !== 6) {
      setErrors({ otp: "Enter the 6-digit code we sent you." });
      return;
    }
    if (!supabase) {
      setErrors({ global: "Authentication is not configured." });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${getApiBaseURL()}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otp, password, name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.message ?? "That code didn't work. Please try again.");
      }

      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      toast.success("Account created. Welcome to Numeriqu.");
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setErrors({
        global: caught instanceof Error ? caught.message : "We could not verify that code.",
      });
    } finally {
      setLoading(false);
    }
  };

  const strength = passwordStrength(password);

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-hero-luxury px-6 py-16">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between text-xs">
          <Link href="/" className="text-text-muted transition-colors hover:text-text-primary">
            ← Back to landing
          </Link>
          <span className="font-mono uppercase tracking-[0.24em] text-text-muted">
            {step === "form" ? "Create account" : "Verify email"}
          </span>
        </div>

        <Surface className="space-y-7 p-8">
          <header className="space-y-2">
            <h1 className="text-3xl font-bold text-text-primary">
              {step === "form" ? "Create your workspace" : "Confirm your email"}
            </h1>
            <p className="text-sm text-text-muted">
              {step === "form"
                ? "Free to start. Connect your accounting in under five minutes."
                : `We sent a 6-digit code to ${email}. Enter it below to finish.`}
            </p>
          </header>

          {errors.global ? <ErrorBanner title="Sign-up failed">{errors.global}</ErrorBanner> : null}

          {step === "form" ? (
            <form onSubmit={handleSendOtp} className="space-y-5" noValidate>
              <Field
                label="Full name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Alex Morgan"
                error={errors.name}
              />
              <Field
                label="Work email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="alex@company.com"
                error={errors.email}
              />
              <div>
                <Field
                  label="Password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  hint={strength.label}
                  error={errors.password}
                />
                <div className="mt-2 flex h-1 gap-1">
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        strength.score > index
                          ? strength.score >= 3
                            ? "bg-feedback-success"
                            : strength.score === 2
                              ? "bg-feedback-info"
                              : "bg-feedback-warning"
                          : "bg-text-muted/20"
                      }`}
                      aria-hidden
                    />
                  ))}
                </div>
              </div>

              <Button type="submit" className="w-full" loading={loading}>
                {loading ? "Sending code..." : "Send verification code"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-5" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="signup-otp" className="block text-sm font-medium text-text-secondary">
                  Verification code
                </label>
                <input
                  id="signup-otp"
                  ref={otpRef}
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  aria-invalid={Boolean(errors.otp) || undefined}
                  aria-describedby={errors.otp ? "signup-otp-error" : undefined}
                  className="w-full rounded-xl border border-default bg-surface-card/70 px-4 py-3 text-center font-mono text-2xl tracking-[0.5em] text-text-primary outline-none transition-colors focus:border-accent-blue/60"
                />
                {errors.otp ? (
                  <p id="signup-otp-error" className="text-xs text-feedback-danger">
                    {errors.otp}
                  </p>
                ) : (
                  <p className="text-xs text-text-muted">Codes expire in 10 minutes.</p>
                )}
              </div>

              <Button type="submit" className="w-full" loading={loading} disabled={otp.length !== 6}>
                {loading ? "Verifying..." : "Verify and continue"}
              </Button>

              <div className="flex items-center justify-between text-xs text-text-muted">
                <button
                  type="button"
                  onClick={() => {
                    setStep("form");
                    setOtp("");
                    setErrors({});
                  }}
                  className="hover:text-text-primary"
                >
                  ← Edit details
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resendIn > 0 || loading}
                  className="font-medium text-accent-blue hover:underline disabled:cursor-not-allowed disabled:text-text-muted"
                >
                  {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}

          <div className="border-t border-default pt-5 text-center text-sm text-text-muted">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-accent-blue hover:underline">
              Sign in
            </Link>
          </div>
        </Surface>
      </div>
    </main>
  );
}
