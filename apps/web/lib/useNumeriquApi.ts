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
import { getApiBaseURL } from "./api/base";

const DEV_TOKEN_KEY = "numeriqu.devToken";
let sessionCache: CurrentUserResponse | null = null;
let sessionKnown = false;
let sessionInFlight: Promise<CurrentUserResponse | null> | null = null;

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

  const refreshSession = useCallback(async () => {
    setAuthState("loading");
    if (!sessionInFlight) {
      sessionInFlight = auth
        .me()
        .then((me) => {
          sessionKnown = true;
          sessionCache = me;
          return me;
        })
        .catch((caught) => {
          if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
            sessionKnown = true;
            sessionCache = null;
            return null;
          }
          sessionKnown = true;
          sessionCache = null;
          return null;
        })
        .finally(() => {
          sessionInFlight = null;
        });
    }
    const me = await sessionInFlight;
    setCurrentUser(me);
    setAuthState(me ? "authenticated" : "unauthenticated");
  }, [auth]);

  useEffect(() => {
    if (sessionKnown && manualToken === null) {
      setCurrentUser(sessionCache);
      setAuthState(sessionCache ? "authenticated" : "unauthenticated");
      return;
    }
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
  };
}
