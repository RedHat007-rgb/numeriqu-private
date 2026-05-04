"use client";

import React, { useState } from "react";
import { useAuth } from "../providers";
import { useRouter } from "next/navigation";
import { GlassCard, GlowButton } from "@repo/ui";
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
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      toast.success("Successfully authenticated.");
      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      toast.error(err.message || "Authentication failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-hero-luxury">
      <GlassCard className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">Welcome Back</h1>
          <p className="text-text-muted">Enter your credentials to access the command center.</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
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
              className="w-full bg-slate-800/50 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-blue-500/50 transition-colors"
              placeholder="••••••••"
            />
          </div>

          <GlowButton className="w-full" disabled={loading}>
            {loading ? "Authenticating..." : "Sign In"}
          </GlowButton>
        </form>

        <div className="mt-8 text-center text-sm">
          <span className="text-text-muted">Don't have an account? </span>
          <Link href="/signup" className="text-blue-400 hover:text-blue-300 font-medium">
            Create Account
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
