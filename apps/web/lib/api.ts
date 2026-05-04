/**
 * Compatibility shim: this file used to host the monolithic API client.
 * It now re-exports the modular client in `lib/api/` so the codebase has a
 * single source of truth while existing imports continue to work.
 */
export * from "./api/index";
