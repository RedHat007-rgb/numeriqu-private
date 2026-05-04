"use client";

import React, { useState } from "react";
import { useAuth } from "../providers";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { supabase } = useAuth();
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      toast.error("Auth not configured. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success("Welcome back.");
      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Authentication failed.");
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

        <div className="relative space-y-6">
          <blockquote className="text-xl font-display leading-relaxed text-text-primary">
            &ldquo;NumeriQu replaced four different reporting tools and gave us a single view we could actually trust.&rdquo;
          </blockquote>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent font-semibold text-sm">
              SC
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">Sarah Chen</p>
              <p className="text-xs text-text-muted">CFO, Meridian Logistics</p>
            </div>
          </div>
        </div>

        <div className="relative flex items-center gap-4">
          <div className="flex -space-x-2">
            {["#2563EB", "#7C3AED", "#06B6D4", "#10B981"].map((color) => (
              <div key={color} className="w-7 h-7 rounded-full border-2 border-ink" style={{ backgroundColor: color }} />
            ))}
          </div>
          <p className="text-xs text-text-muted">
            <span className="text-text-primary font-medium">200+ teams</span> · SOC 2 compliant
          </p>
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

          <div className="mb-8">
            <h1 className="text-2xl font-display font-bold text-text-primary mb-1">Welcome back</h1>
            <p className="text-sm text-text-muted">Sign in to your financial intelligence platform.</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary uppercase tracking-widest mb-2">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="jane@company.com"
                autoComplete="email"
                className="w-full bg-surface border border-white/[0.08] hover:border-white/[0.14] focus:border-accent/50 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-muted text-sm outline-none transition-all duration-200 focus:ring-1 focus:ring-accent/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-medium text-text-secondary uppercase tracking-widest">
                  Password
                </label>
                <a href="#" className="text-xs text-accent-glow hover:text-accent transition-colors duration-200">
                  Forgot password?
                </a>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full bg-surface border border-white/[0.08] hover:border-white/[0.14] focus:border-accent/50 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-muted text-sm outline-none transition-all duration-200 focus:ring-1 focus:ring-accent/20"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 px-6 py-3 rounded-xl bg-accent hover:bg-accent-glow text-white font-semibold text-sm shadow-glow-blue/50 transition-all duration-300 hover:shadow-glow-blue disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in…" : "Sign in →"}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-text-muted">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-accent-glow hover:text-accent font-medium transition-colors">
              Create account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
