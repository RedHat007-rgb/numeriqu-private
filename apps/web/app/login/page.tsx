"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Surface } from "../../components/ui/Surface";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ThemeToggle } from "../../components/ui/ThemeToggle";
import { useAuth } from "../providers";

type FormErrors = {
  email?: string;
  password?: string;
  global?: string;
};

function emailLooksValid(value: string) {
  return /.+@.+\..+/.test(value);
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const { supabase } = useAuth();
  const router = useRouter();

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});

    const next: FormErrors = {};
    if (!email) next.email = "Email is required.";
    else if (!emailLooksValid(email)) next.email = "Enter a valid work email.";
    if (!password) next.password = "Password is required.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    if (!supabase) {
      setErrors({
        global:
          "Authentication is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to enable sign-in.",
      });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        const friendly =
          error.message?.toLowerCase().includes("invalid")
            ? "Email or password is incorrect."
            : error.message ?? "Sign-in failed. Please try again.";
        setErrors({ global: friendly });
        return;
      }

      toast.success("Welcome back to Numeriqu.");
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sign-in failed. Please try again.";
      setErrors({ global: message });
    } finally {
      setLoading(false);
    }
  };

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
          <span className="font-mono uppercase tracking-[0.24em] text-text-muted">Sign in</span>
        </div>

        <Surface className="space-y-7 p-8">
          <header className="space-y-2">
            <h1 className="text-3xl font-bold text-text-primary">Welcome back</h1>
            <p className="text-sm text-text-muted">
              Sign in to your Numeriqu workspace to access dashboards, sync jobs,
              and the RAG advisor.
            </p>
          </header>

          {errors.global ? <ErrorBanner title="Sign-in failed">{errors.global}</ErrorBanner> : null}

          <form onSubmit={handleLogin} className="space-y-5" noValidate>
            <Field
              label="Work email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              error={errors.email}
            />

            <div className="space-y-1.5">
              <Field
                label="Password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                error={errors.password}
              />
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="text-text-muted transition-colors hover:text-text-primary"
                >
                  {showPassword ? "Hide" : "Show"} password
                </button>
                <Link href="/signup" className="text-text-muted hover:text-text-primary">
                  Forgot password?
                </Link>
              </div>
            </div>

            <Button type="submit" className="w-full" loading={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <div className="border-t border-default pt-5 text-center text-sm text-text-muted">
            New to Numeriqu?{" "}
            <Link href="/signup" className="font-medium text-accent-blue hover:underline">
              Create a free account
            </Link>
          </div>
        </Surface>

        <p className="mt-6 text-center text-xs text-text-muted">
          By continuing you agree to Numeriqu&apos;s{" "}
          <a href="#trust" className="underline hover:text-text-primary">
            terms and privacy
          </a>
          .
        </p>
      </div>
    </main>
  );
}
