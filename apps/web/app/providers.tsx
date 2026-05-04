"use client";

import React, { createContext, useContext } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";

type AuthContextValue = {
  loading: boolean;
};

const AuthContext = createContext<AuthContextValue>({
  loading: false,
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  return <AuthContext.Provider value={{ loading: false }}>{children}</AuthContext.Provider>;
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

