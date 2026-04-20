#!/usr/bin/env node
/**
 * Frees local Next dev ports and removes stale Next 16+ `.next/dev` lock
 * so "Another next dev server is already running" goes away.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function killPort(port) {
  if (process.platform === "win32") {
    return;
  }
  try {
    const out = execSync(`lsof -ti tcp:${port}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!out) return;
    for (const pid of out.split(/\s+/)) {
      if (!pid) continue;
      try {
        process.kill(Number(pid), "SIGKILL");
        console.log(`[kill-next-dev] freed port ${port} (PID ${pid})`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* nothing listening */
  }
}

for (const port of [3001, 3010]) {
  killPort(port);
}

const devDir = path.join(webRoot, ".next", "dev");
if (fs.existsSync(devDir)) {
  fs.rmSync(devDir, { recursive: true, force: true });
  console.log("[kill-next-dev] removed .next/dev (stale dev session)");
}
