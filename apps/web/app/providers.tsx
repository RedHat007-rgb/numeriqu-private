"use client";

import React, { createContext, useContext } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";

type AuthContextValue = {
  loading: boolean;
  user: unknown | null;
  supabase: unknown | null;
};

const AuthContext = createContext<AuthContextValue>({
  loading: false,
  user: null,
  supabase: null,
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <AuthContext.Provider value={{ loading: false, user: null, supabase: null }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      themes={["light"]}
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
