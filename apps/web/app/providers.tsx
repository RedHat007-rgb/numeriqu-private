"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import type {
  AuthChangeEvent,
  Session,
  SupabaseClient,
  User,
} from "@supabase/supabase-js";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { getSupabaseClient } from "../lib/supabase";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  supabase: SupabaseClient | null;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  supabase: null,
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = getSupabaseClient();

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    const fetchSession = async () => {
      const {
        data: { user: nextUser },
      } = await supabase.auth.getUser();
      setUser(nextUser ?? null);
      setLoading(false);
    };

    void fetchSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  return (
    <AuthContext.Provider value={{ user, loading, supabase }}>{children}</AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      themes={["light", "dark"]}
    >
      <AuthProvider>
        {children}
        <Toaster
          position="top-right"
          richColors
          theme="system"
          closeButton
          toastOptions={{
            classNames: {
              toast:
                "rounded-2xl border border-default bg-bg-card text-text-primary shadow-glass",
            },
          }}
        />
      </AuthProvider>
    </ThemeProvider>
  );
}
