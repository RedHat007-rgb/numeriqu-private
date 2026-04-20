"use client";

import React, { useState } from "react";
import { useAuth } from "../providers";
import { useRouter } from "next/navigation";
import { GlassCard, GlowButton } from "@repo/ui";
import { toast } from "sonner";
import Link from "next/link";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const { supabase } = useAuth();
  const router = useRouter();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: name,
          },
        },
      });

      if (error) throw error;

      toast.success("Account created! Please sign in.");
      router.push("/login");
    } catch (err: any) {
      toast.error(err.message || "Registration failed.");
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

        <form onSubmit={handleSignup} className="space-y-6">
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
              className="w-full bg-slate-800/50 border border-white/10 rounded-lg px-4 py-2.5 text-white outline-none focus:border-blue-500/50 transition-colors"
              placeholder="••••••••"
            />
          </div>

          <GlowButton className="w-full" disabled={loading}>
            {loading ? "Creating Account..." : "Sign Up"}
          </GlowButton>
        </form>

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
