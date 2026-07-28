/**
 * Feature locks for surfaces that ship behind a "coming soon" page.
 *
 * Locked by default and opened by setting the flag to the literal string
 * "false" — so a missing or malformed env var fails closed rather than
 * exposing an unfinished surface. Mirrors the existing Prism gate in
 * RagWorkbench.tsx (`NEXT_PUBLIC_PRISM_LOCKED`).
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so these read identically from
 * server and client components.
 */

/** Signals inbox + signal detail. Unlock with NEXT_PUBLIC_SIGNALS_LOCKED=false. */
export const SIGNALS_LOCKED = process.env.NEXT_PUBLIC_SIGNALS_LOCKED !== "false";
