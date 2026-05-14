"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AgentApi,
  AnalyticsApi,
  AuthApi,
  DashboardsApi,
  IntegrationsApi,
  MessagingApi,
  OrganizationApi,
  RagApi,
  type CurrentUserResponse,
  ApiError,
} from "./api";
import { getApiBaseURL, setSelectedOrganizationCookie, SELECTED_ORG_ID_KEY } from "./api/base";

const DEV_TOKEN_KEY = "numeriqu.devToken";
let sessionCache: CurrentUserResponse | null = null;
let sessionKnown = false;
let refreshSeq = 0;

export function useNumeriquApi() {
  const [manualToken, setManualToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(DEV_TOKEN_KEY);
  });

  const getToken = useMemo(() => {
    return async () => manualToken;
  }, [manualToken]);

  const auth = useMemo(() => new AuthApi(getToken), [getToken]);
  const analytics = useMemo(() => new AnalyticsApi(getToken), [getToken]);
  const integrations = useMemo(() => new IntegrationsApi(getToken), [getToken]);
  const rag = useMemo(() => new RagApi(getToken), [getToken]);
  const agent = useMemo(() => new AgentApi(getToken), [getToken]);
  const organization = useMemo(() => new OrganizationApi(getToken), [getToken]);
  const messaging = useMemo(() => new MessagingApi(getToken), [getToken]);
  const dashboards = useMemo(() => new DashboardsApi(getToken), [getToken]);

  const [authState, setAuthState] = useState<"loading" | "authenticated" | "unauthenticated">(
    sessionKnown ? (sessionCache ? "authenticated" : "unauthenticated") : "loading",
  );
  const [currentUser, setCurrentUser] = useState<CurrentUserResponse | null>(sessionCache);
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshSession = useCallback(
    async () => {
      const seq = (refreshSeq += 1);

      // Avoid UI flashing to "logged out" while a refresh is in-flight.
      if (!sessionCache) setAuthState("loading");

      const apply = (me: CurrentUserResponse | null) => {
        // Ignore stale responses when a newer refresh was kicked off.
        if (seq !== refreshSeq) return { me, applied: false as const };
        sessionKnown = true;
        sessionCache = me;
        setCurrentUser(me);
        setAuthState(me ? "authenticated" : "unauthenticated");
        setAuthError(null);
        return { me, applied: true as const, message: null as string | null };
      };

      const keepExistingSession = (message?: string) => {
        // If we already have a session in memory, keep it rather than forcing the UI
        // back to the auth screen on transient failures.
        if (sessionCache) {
          if (seq === refreshSeq) {
            setCurrentUser(sessionCache);
            setAuthState("authenticated");
            if (message) setAuthError(message);
          }
          return { me: sessionCache, error: true as const, message: message ?? null };
        }
        // No cached session to fall back to: settle the UI out of the loading state.
        if (seq === refreshSeq) {
          setCurrentUser(null);
          setAuthState("unauthenticated");
          if (message) setAuthError(message);
        }
        return { me: null, error: true as const, message: message ?? null };
      };

      try {
        const me = await auth.me();
        return { ...apply(me), error: false as const };
      } catch (caught) {
        // Invalid org selection: if this was a normal refresh (not an explicit switch attempt),
        // clear the stored workspace selection and retry once without an org override.
        if (caught instanceof ApiError && caught.status === 403) {
          try {
            if (typeof window !== "undefined") {
              window.localStorage.removeItem(SELECTED_ORG_ID_KEY);
            }
          } catch {
            // ignore
          }
          try {
            setSelectedOrganizationCookie(null);
          } catch {
            // ignore
          }
          try {
            const me = await auth.me();
            return { ...apply(me), error: false as const };
          } catch (retryError) {
            if (retryError instanceof ApiError && retryError.status === 401) {
              return { ...apply(null), error: false as const };
            }
            // Don't treat non-auth errors as a logout if we have a usable session already.
            if (seq === refreshSeq) sessionKnown = true;
            return keepExistingSession(
              retryError instanceof ApiError ? retryError.toUserMessage("Couldn't refresh session.") : "Couldn't refresh session.",
            );
          }
        }

        if (caught instanceof ApiError && caught.status === 401) {
          return { ...apply(null), error: false as const };
        }

        if (seq === refreshSeq) sessionKnown = true;
        return keepExistingSession(
          caught instanceof ApiError ? caught.toUserMessage("Couldn't refresh session.") : "Couldn't refresh session.",
        );
      }
    },
    [auth],
  );

  useEffect(() => {
    if (sessionKnown && manualToken === null) {
      setCurrentUser(sessionCache);
      setAuthState(sessionCache ? "authenticated" : "unauthenticated");
    }
    // Always revalidate so transient failures or stale org selections don't "stick" forever.
    void refreshSession();
  }, [refreshSession, manualToken]);

  function useDevToken(token: string) {
    if (!token) return;
    window.localStorage.setItem(DEV_TOKEN_KEY, token);
    setManualToken(token);
  }

  async function signOut() {
    window.localStorage.removeItem(DEV_TOKEN_KEY);
    setManualToken(null);
    await fetch(`${getApiBaseURL()}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    setCurrentUser(null);
    setAuthState("unauthenticated");
    sessionKnown = true;
    sessionCache = null;
  }

  return {
    auth,
    analytics,
    integrations,
    rag,
    agent,
    organization,
    messaging,
    dashboards,
    loading: authState === "loading",
    manualToken,
    isAuthenticated: authState === "authenticated",
    currentUser,
    useDevToken,
    signOut,
    refreshSession,
    authError,
  };
}
