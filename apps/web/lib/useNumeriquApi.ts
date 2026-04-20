"use client";

import { useEffect, useMemo, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabase";
import { AgentApi, AnalyticsApi, AuthApi, IntegrationsApi, RagApi } from "./api";

const DEV_TOKEN_KEY = "numeriqu.devToken";

export function useNumeriquApi() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualToken, setManualToken] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(DEV_TOKEN_KEY);
    if (stored) setManualToken(stored);

    if (!supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, nextSession: Session | null) => {
        setSession(nextSession);
        setLoading(false);
      },
    );
    return () => subscription.unsubscribe();
  }, [supabase]);

  const getToken = useMemo(() => {
    return async () => {
      if (manualToken) return manualToken;
      if (!supabase) return null;
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    };
  }, [manualToken, supabase]);

  const auth = useMemo(() => new AuthApi(getToken), [getToken]);
  const analytics = useMemo(() => new AnalyticsApi(getToken), [getToken]);
  const integrations = useMemo(() => new IntegrationsApi(getToken), [getToken]);
  const rag = useMemo(() => new RagApi(getToken), [getToken]);
  const agent = useMemo(() => new AgentApi(getToken), [getToken]);

  const isAuthenticated = Boolean(manualToken || session?.access_token);

  function useDevToken(token: string) {
    if (!token) return;
    window.localStorage.setItem(DEV_TOKEN_KEY, token);
    setManualToken(token);
  }

  async function signOut() {
    window.localStorage.removeItem(DEV_TOKEN_KEY);
    setManualToken(null);
    await supabase?.auth.signOut();
    setSession(null);
  }

  return {
    auth,
    analytics,
    integrations,
    rag,
    agent,
    supabase,
    session,
    loading,
    manualToken,
    isAuthenticated,
    useDevToken,
    signOut,
  };
}
