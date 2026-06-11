/**
 * Attach the 5 demo users (demo1-5@numeriqu.com) as ADMIN members of a given org,
 * so they can switch into it from the org picker. Purely additive: it does NOT
 * touch any other membership, connection, or data. Run it for the new EBPO org;
 * the demo users keep their existing Sample Company 2024 membership too, so they
 * can switch between BOTH orgs.
 *
 * Usage:
 *   pnpm --filter @repo/db exec tsx scripts/attach-demo-users-to-org.ts \
 *     --org-slug enterprise-bpo --allow-remote
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

const DEMO_EMAILS = [
  "demo1@numeriqu.com",
  "demo2@numeriqu.com",
  "demo3@numeriqu.com",
  "demo4@numeriqu.com",
  "demo5@numeriqu.com",
];

async function getPrisma() {
  const mod = await import("../src/client");
  return mod.prisma as typeof mod.prisma;
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function isLocalHost(host: string) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1";
}

function assertRemoteAllowed(url: string | undefined, allowRemote: boolean, label: string) {
  if (!url) throw new Error(`${label} URL is missing from env.`);
  const parsed = new URL(url);
  if (!isLocalHost(parsed.hostname) && !allowRemote) {
    throw new Error(
      `Refusing to connect to non-local ${label} host (${parsed.hostname}). Re-run with --allow-remote if this is intentional.`,
    );
  }
}

async function main() {
  const orgSlug = getArg("--org-slug");
  if (!orgSlug) throw new Error("Missing required argument: --org-slug <slug>");
  const allowRemote = hasFlag("--allow-remote");

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  assertRemoteAllowed(process.env.DATABASE_URL, allowRemote, "Postgres");

  const prisma = await getPrisma();
  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!org) throw new Error(`Organization not found for slug "${orgSlug}".`);

  const results: Array<{ email: string; status: string }> = [];
  for (const email of DEMO_EMAILS) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      results.push({ email, status: "SKIPPED_USER_NOT_FOUND" });
      continue;
    }
    await prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      create: {
        organizationId: org.id,
        userId: user.id,
        role: "ADMIN",
        canViewDashboard: true,
        canCreateDashboard: true,
        canShareDashboard: true,
        leftAt: null,
      },
      update: {
        role: "ADMIN",
        canViewDashboard: true,
        canCreateDashboard: true,
        canShareDashboard: true,
        leftAt: null,
      },
    });
    results.push({ email, status: "MEMBER" });
  }

  console.log(
    JSON.stringify(
      { ok: true, org: { id: org.id, slug: org.slug, name: org.name }, members: results },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const prisma = await getPrisma();
      await prisma.$disconnect();
    } catch {
      // ignore
    }
  });
