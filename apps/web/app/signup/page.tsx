"use client";

import React, { useState } from "react";
import { useAuth } from "../providers";
import { useRouter } from "next/navigation";
import { GlassCard, GlowButton } from "@repo/ui";
import { toast } from "sonner";
import Link from "next/link";
import { API_BASE_URL } from "../../lib/api/base";

type Step = "form" | "otp";

export default function SignupPage() {
  const [step, setStep] = useState<Step>("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const { supabase } = useAuth();
  const router = useRouter();

  // Step 1: validate form + send OTP via backend (Resend)
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      toast.error("Auth not configured. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
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
      toast.success("Verification code sent. Check your inbox.");
    } catch (err: any) {
      toast.error(err.message || "Failed to send verification code.");
    } finally {
      setLoading(false);
    }
  };

  // Step 2: verify OTP + backend creates Supabase user + sign in
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otp, password, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Verification failed.");

      // User is created and confirmed in Supabase — sign in immediately
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      toast.success("Account created!");
      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      toast.error(err.message || "Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-hero-luxury">
      <GlassCard className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">Create Account</h1>
          <p className="text-text-muted">Start your journey with strategic financial intelligence.</p>
        </div>

        {step === "form" ? (
          <form onSubmit={handleSendOtp} className="space-y-6">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-blue-200">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-slate-800/50 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-blue-500/50 transition-colors"
                placeholder="John Doe"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5 text-blue-200">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-slate-800/50 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-blue-500/50 transition-colors"
                placeholder="name@company.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5 text-blue-200">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full bg-slate-800/50 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-blue-500/50 transition-colors"
                placeholder="••••••••"
              />
            </div>

            <GlowButton className="w-full" disabled={loading}>
              {loading ? "Sending Code..." : "Send Verification Code"}
            </GlowButton>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-6">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-blue-200">Verification Code</label>
              <p className="text-xs text-text-muted mb-3">
                Enter the 6-digit code sent to <span className="text-blue-300">{email}</span>
              </p>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                maxLength={6}
                className="w-full bg-slate-800/50 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-blue-500/50 transition-colors text-center text-2xl tracking-[0.5em]"
                placeholder="000000"
                autoFocus
              />
            </div>

            <GlowButton className="w-full" disabled={loading || otp.length !== 6}>
              {loading ? "Verifying..." : "Verify & Create Account"}
            </GlowButton>

            <button
              type="button"
              onClick={() => { setStep("form"); setOtp(""); }}
              className="w-full text-sm text-text-muted hover:text-white transition-colors"
            >
              ← Back / Resend code
            </button>
          </form>
        )}

        <div className="mt-8 text-center text-sm">
          <span className="text-text-muted">Already have an account? </span>
          <Link href="/login" className="text-blue-400 hover:text-blue-300 font-medium">
            Sign In
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
