import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Nest API (rewrite target). Override if the API listens elsewhere. */
const apiProxyTarget =
  process.env.API_PROXY_TARGET?.replace(/\/$/, "") || "http://127.0.0.1:3000";

/**
 * Monorepo root — must be absolute so Next never infers a parent folder (e.g. $HOME)
 * when another lockfile exists higher in the tree (common cause of full-system freezes).
 */
const turbopackRoot = path.resolve(__dirname, "../..");
if (!fs.existsSync(path.join(turbopackRoot, "pnpm-workspace.yaml"))) {
  console.warn(
    `[next.config] turbopack.root ${turbopackRoot} has no pnpm-workspace.yaml — dev file watching may misbehave.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: turbopackRoot,
  },
  /** Webpack dev only: ignore huge subtrees (must stay string globs — Next defaults mix in RegExp). */
  webpack: (config, { dev }) => {
    if (dev) {
      const extra = [
        "**/packages/analytics/dbt_venv/**",
        "**/.turbo/**",
        "**/.next/**",
      ];
      const prev = config.watchOptions?.ignored;
      const prevStrings = Array.isArray(prev)
        ? prev.filter((x) => typeof x === "string" && x.length > 0)
        : typeof prev === "string" && prev.length > 0
          ? [prev]
          : [];
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [...prevStrings, ...extra],
      };
    }
    return config;
  },
  async rewrites() {
    return [
      // Use a non-`/api/*` prefix to avoid aggressive extension/adblock rules.
      {
        source: "/_nq/:path*",
        destination: `${apiProxyTarget}/:path*`,
      },
      // Stable proxy path that is unlikely to match adblock filters.
      {
        source: "/api/proxy/:path*",
        destination: `${apiProxyTarget}/:path*`,
      },
      // Primary API proxy path (avoid adblock/extension rules that sometimes match "numeriqu").
      {
        source: "/api/app/:path*",
        destination: `${apiProxyTarget}/:path*`,
      },
      {
        source: "/api/numeriqu/:path*",
        destination: `${apiProxyTarget}/:path*`,
      },
    ];
  },
  compiler: {
    styledComponents: true,
  },
};

export default nextConfig;
