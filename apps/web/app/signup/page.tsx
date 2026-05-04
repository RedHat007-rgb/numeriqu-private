"use client";

import React, { useState } from "react";
import { useAuth } from "../providers";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { API_BASE_URL } from "../../lib/api/base";

type Step = "form" | "otp";
type AccountType = "solo" | "organization";

function InputField({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  required,
  minLength,
  maxLength,
  autoFocus,
  className = "",
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary uppercase tracking-widest mb-2">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={`w-full bg-surface border border-white/[0.08] hover:border-white/[0.14] focus:border-accent/50 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-muted text-sm outline-none transition-all duration-200 focus:ring-1 focus:ring-accent/20 ${className}`}
      />
    </div>
  );
}

export default function SignupPage() {
  const [step, setStep] = useState<Step>("form");
  const [accountType, setAccountType] = useState<AccountType>("solo");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const { supabase } = useAuth();
  const router = useRouter();

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      toast.error("Auth not configured. Check environment variables.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to send code.");
      setStep("otp");
      toast.success("Verification code sent — check your inbox.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send verification code.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          code: otp,
          password,
          name,
          accountType,
          orgName: accountType === "organization" ? orgName : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Verification failed.");

      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      toast.success("Account created — welcome to NumeriQu.");
      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-void flex">
      {/* Left panel — branding */}
      <div className="hidden lg:flex flex-col justify-between w-[45%] bg-ink border-r border-white/[0.04] p-12 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-hero opacity-60" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-accent/8 rounded-full blur-[120px]" />

        <div className="relative">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center shadow-glow-blue group-hover:scale-110 transition-transform duration-300">
              <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white" aria-hidden>
                <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" fill="currentColor" />
              </svg>
            </div>
            <span className="font-display font-semibold text-text-primary">NumeriQu</span>
          </Link>
        </div>

        <div className="relative space-y-8">
          <div>
            <h2 className="text-3xl font-display font-bold text-text-primary leading-tight mb-4">
              From raw data to{" "}
              <span className="font-serif italic text-accent-glow">boardroom clarity</span>
            </h2>
            <p className="text-text-secondary leading-relaxed">
              Connect your entire financial stack in minutes. Ask questions in plain English. Get answers your CFO can act on.
            </p>
          </div>

          <div className="space-y-4">
            {[
              "Real-time unified financial dashboard",
              "AI-powered RAG chat over your org's data",
              "Anomaly detection & spend alerts",
              "Role-based access for your entire team",
            ].map((feature) => (
              <div key={feature} className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-accent-emerald/10 border border-accent-emerald/30 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3 text-accent-emerald" aria-hidden>
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <span className="text-sm text-text-secondary">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative">
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface/60 border border-white/[0.06]">
            <div className="flex -space-x-2">
              {["#2563EB", "#7C3AED", "#06B6D4", "#10B981"].map((color) => (
                <div key={color} className="w-7 h-7 rounded-full border-2 border-ink" style={{ backgroundColor: color }} />
              ))}
            </div>
            <p className="text-xs text-text-secondary">
              <span className="text-text-primary font-medium">200+ teams</span> trust NumeriQu with their financial data
            </p>
          </div>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-2.5 mb-10">
            <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white" aria-hidden>
                <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" fill="currentColor" />
              </svg>
            </div>
            <span className="font-display font-semibold text-text-primary">NumeriQu</span>
          </div>

          {step === "form" ? (
            <>
              <div className="mb-8">
                <h1 className="text-2xl font-display font-bold text-text-primary mb-1">Create your account</h1>
                <p className="text-sm text-text-muted">Start your 14-day free trial — no card required.</p>
              </div>

              {/* Account type selector */}
              <div className="grid grid-cols-2 gap-3 mb-7">
                {(["solo", "organization"] as AccountType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setAccountType(type)}
                    className={`relative flex flex-col items-start gap-1.5 p-4 rounded-xl border transition-all duration-200 text-left ${
                      accountType === type
                        ? "border-accent/50 bg-accent/5 ring-1 ring-accent/20"
                        : "border-white/[0.07] bg-surface hover:border-white/[0.14]"
                    }`}
                  >
                    <div className={`text-xs font-semibold tracking-wide uppercase ${accountType === type ? "text-accent-glow" : "text-text-secondary"}`}>
                      {type === "solo" ? "Solo" : "Organization"}
                    </div>
                    <div className="text-[11px] text-text-muted leading-tight">
                      {type === "solo" ? "Individual analyst or CFO" : "Team with admin controls"}
                    </div>
                    {accountType === type && (
                      <div className="absolute top-3 right-3 w-4 h-4 rounded-full bg-accent flex items-center justify-center">
                        <svg viewBox="0 0 8 8" fill="none" className="w-2.5 h-2.5 text-white" aria-hidden>
                          <path d="M1 4l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    )}
                  </button>
                ))}
              </div>

              <form onSubmit={handleSendOtp} className="space-y-4">
                <InputField label="Full name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" required />

                {accountType === "organization" && (
                  <InputField
                    label="Organization name"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Acme Corp"
                    required
                  />
                )}

                <InputField label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" required />

                <InputField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 8 characters" required minLength={8} />

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full mt-2 px-6 py-3 rounded-xl bg-accent hover:bg-accent-glow text-white font-semibold text-sm shadow-glow-blue/50 transition-all duration-300 hover:shadow-glow-blue disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Sending code…" : "Continue →"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-8">
                <button
                  type="button"
                  onClick={() => { setStep("form"); setOtp(""); }}
                  className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors duration-200 mb-6"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5" aria-hidden>
                    <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back
                </button>
                <h1 className="text-2xl font-display font-bold text-text-primary mb-1">Check your email</h1>
                <p className="text-sm text-text-muted">
                  We sent a 6-digit code to{" "}
                  <span className="text-accent-glow font-medium">{email}</span>
                </p>
              </div>

              <form onSubmit={handleVerify} className="space-y-5">
                <div>
                  <label className="block text-xs font-medium text-text-secondary uppercase tracking-widest mb-2">
                    Verification code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                    maxLength={6}
                    autoFocus
                    placeholder="000000"
                    className="w-full bg-surface border border-white/[0.08] hover:border-white/[0.14] focus:border-accent/50 rounded-xl px-4 py-4 text-text-primary placeholder:text-text-muted text-center text-3xl font-mono tracking-[0.6em] outline-none transition-all duration-200 focus:ring-1 focus:ring-accent/20"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || otp.length !== 6}
                  className="w-full px-6 py-3 rounded-xl bg-accent hover:bg-accent-glow text-white font-semibold text-sm shadow-glow-blue/50 transition-all duration-300 hover:shadow-glow-blue disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {loading ? "Verifying…" : "Create account"}
                </button>

                <button
                  type="button"
                  onClick={handleSendOtp}
                  disabled={loading}
                  className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors duration-200 py-1"
                >
                  Didn&apos;t receive it? Resend code
                </button>
              </form>
            </>
          )}

          <p className="mt-8 text-center text-xs text-text-muted">
            Already have an account?{" "}
            <Link href="/login" className="text-accent-glow hover:text-accent font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
