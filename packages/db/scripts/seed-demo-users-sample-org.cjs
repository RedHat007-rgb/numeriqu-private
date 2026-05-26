/* eslint-disable no-console */
/**
 * Seed the shared "Sample Company 2024" organization and attach ALL demo users to it.
 *
 * Goals:
 * - Exactly one shared org (by slug) for demo users.
 * - Ensure demo users exist in both Supabase Auth + app DB (Prisma).
 * - Ensure every demo user has an active membership in the shared org.
 * - Optionally deactivate (leftAt) any other memberships for demo users.
 *
 * Usage:
 *   pnpm --dir packages/db exec node scripts/seed-demo-users-sample-org.cjs
 *   pnpm --dir packages/db exec node scripts/seed-demo-users-sample-org.cjs --only-sample-org
 *   pnpm --dir packages/db exec node scripts/seed-demo-users-sample-org.cjs --dry-run
 *
 * Env (same as API auth flow):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (or SUPABASE_KEY)
 *   SUPABASE_INTERNAL_AUTH_SECRET
 * Optional:
 *   DEMO_ORG_SLUG (default: sample-company-2024)
 *   DEMO_ORG_NAME (default: Sample Company 2024)
 */

const path = require('node:path');
const { createHash } = require('node:crypto');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { createClient: createCHClient } = require('@clickhouse/client');

dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../apps/api/.env'), quiet: true });

function prisma() {
  // packages/db is compiled as CJS; the built client is required for scripts.
  return require('../dist/client.js').prisma;
}

const DEMO_EMAILS = [
  'demo1@numeriqu.com',
  'demo2@numeriqu.com',
  'demo3@numeriqu.com',
  'demo4@numeriqu.com',
  'demo5@numeriqu.com',
];

const ORG_SLUG = (process.env.DEMO_ORG_SLUG || 'sample-company-2024').trim();
const ORG_NAME = (process.env.DEMO_ORG_NAME || 'Sample Company 2024').trim();
const SAMPLE_EXT_ORG_ID = (process.env.DEMO_EXTERNAL_ORG_ID || 'sample_gl_2024').trim();
const CLICKHOUSE_DB = (process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics').trim();

const ONLY_SAMPLE_ORG = process.argv.includes('--only-sample-org');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_SUPABASE = process.argv.includes('--no-supabase');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return String(value).trim();
}

function servicePassword(email) {
  const seed = getRequiredEnv('SUPABASE_INTERNAL_AUTH_SECRET');
  const digest = createHash('sha256')
    .update(`${seed}:${normalizeEmail(email)}`)
    .digest('hex');
  return `${digest}Aa1!`;
}

async function ensureSupabaseUser(supabaseAdmin, email) {
  const normalized = normalizeEmail(email);
  const password = servicePassword(normalized);

  // 1) Try to find existing Auth user by email (5 demo users → cheap list).
  const { data: listed, error: listError } = await supabaseAdmin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) throw listError;

  const existing = (listed?.users || []).find(
    (u) => normalizeEmail(u.email) === normalized,
  );

  if (existing?.id) {
    // Keep password aligned with the current derived secret so demo login works.
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (updateError) throw updateError;
    return { id: existing.id };
  }

  // 2) Create new Auth user
  const { data: created, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email: normalized,
      password,
      email_confirm: true,
    });
  if (createError || !created?.user?.id) {
    throw createError || new Error(`Failed to create Supabase user for ${normalized}`);
  }
  return { id: created.user.id };
}

function makeClickHouseClient() {
  const url =
    (process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL || '').trim();
  if (!url) return null;

  return createCHClient({
    url,
    username: (process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'default').trim(),
    password: (process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || '').trim(),
  });
}

async function checkSampleDataInClickHouse(ch, tenantId, externalOrgId) {
  if (!ch) return { ok: false, reason: 'CLICKHOUSE_* env not set' };
  try {
    const [gl, tb] = await Promise.all([
      ch.query({
        query: `SELECT count() AS c FROM ${CLICKHOUSE_DB}.sample_gl_dump WHERE tenant_id={t:String} AND org_id={o:String}`,
        query_params: { t: tenantId, o: externalOrgId },
        format: 'JSONEachRow',
      }),
      ch.query({
        query: `SELECT count() AS c FROM ${CLICKHOUSE_DB}.sample_trial_balance WHERE tenant_id={t:String} AND org_id={o:String}`,
        query_params: { t: tenantId, o: externalOrgId },
        format: 'JSONEachRow',
      }),
    ]);
    const glRows = await gl.json();
    const tbRows = await tb.json();
    const glCount = Number(glRows?.[0]?.c ?? 0);
    const tbCount = Number(tbRows?.[0]?.c ?? 0);
    return { ok: true, glCount, tbCount };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function ensureAppUser(db, email, supabaseUserId) {
  const normalized = normalizeEmail(email);
  const existing = await db.user.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, supabaseUserId: true },
  });

  if (existing) {
    if (existing.supabaseUserId !== supabaseUserId) {
      if (DRY_RUN) {
        console.log(`[dry-run] Would relink app user ${normalized} supabaseUserId → ${supabaseUserId}`);
        return existing;
      }
      return db.user.update({
        where: { id: existing.id },
        data: { supabaseUserId, isActive: true, isVerified: true },
        select: { id: true, email: true, supabaseUserId: true },
      });
    }
    if (DRY_RUN) return existing;
    return db.user.update({
      where: { id: existing.id },
      data: { isActive: true, isVerified: true },
      select: { id: true, email: true, supabaseUserId: true },
    });
  }

  const fullName = normalized.split('@')[0] || 'demo';
  if (DRY_RUN) {
    console.log(`[dry-run] Would create app user ${normalized} (supabaseUserId=${supabaseUserId})`);
    return { id: 'dry-run', email: normalized, supabaseUserId };
  }
  return db.user.create({
    data: {
      email: normalized,
      supabaseUserId,
      fullName,
      isActive: true,
      isVerified: true,
    },
    select: { id: true, email: true, supabaseUserId: true },
  });
}

async function main() {
  const db = prisma();

  console.log(`Seeding demo org: slug="${ORG_SLUG}" name="${ORG_NAME}"`);
  console.log(`Demo users: ${DEMO_EMAILS.join(', ')}`);
  console.log(
    `Flags: ${ONLY_SAMPLE_ORG ? '--only-sample-org ' : ''}${DRY_RUN ? '--dry-run ' : ''}${
      NO_SUPABASE ? '--no-supabase ' : ''
    }`.trim() || 'Flags: (none)',
  );

  // Check existing sample org first (so we can validate ClickHouse scope without mutating data).
  const existingSampleOrg = await db.organization.findUnique({
    where: { slug: ORG_SLUG },
    select: { id: true, slug: true },
  });

  if (existingSampleOrg) {
    const ch = makeClickHouseClient();
    const sampleCheck = await checkSampleDataInClickHouse(
      ch,
      existingSampleOrg.id,
      SAMPLE_EXT_ORG_ID,
    );
    if (sampleCheck.ok) {
      console.log(
        `ClickHouse sample data check (${CLICKHOUSE_DB}): tenant_id=${existingSampleOrg.id} org_id=${SAMPLE_EXT_ORG_ID} gl=${sampleCheck.glCount} tb=${sampleCheck.tbCount}`,
      );
    } else {
      console.log(
        `ClickHouse sample data check skipped/failed: ${sampleCheck.reason || 'unknown error'}`,
      );
    }
  } else {
    console.log(
      `Sample org not found in Postgres (slug="${ORG_SLUG}"). Will create it after demo users are ensured.`,
    );
  }

  // Ensure demo users exist (Supabase + app DB)
  const demoAppUsers = [];
  let supabaseAdmin = null;
  if (!NO_SUPABASE) {
    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceRoleKey =
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
    if (!serviceRoleKey) {
      throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY).');
    }
    supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  for (const email of DEMO_EMAILS) {
    let supabaseUserId = null;
    if (supabaseAdmin) {
      const authUser = await ensureSupabaseUser(supabaseAdmin, email);
      supabaseUserId = authUser.id;
    } else {
      const existing = await db.user.findUnique({
        where: { email: normalizeEmail(email) },
        select: { supabaseUserId: true },
      });
      supabaseUserId = existing?.supabaseUserId || null;
      if (!supabaseUserId) {
        throw new Error(
          `Missing app user for ${normalizeEmail(
            email,
          )} and --no-supabase was set. Either remove --no-supabase or create the user by logging in once.`,
        );
      }
    }

    const appUser = await ensureAppUser(db, email, supabaseUserId);
    demoAppUsers.push(appUser);
    console.log(`✅ demo user ready: ${normalizeEmail(email)}`);
  }

  // Upsert the shared org (creates only if missing; does not touch ClickHouse).
  const createdById = demoAppUsers.find((u) => u.id !== 'dry-run')?.id || demoAppUsers[0].id;
  const sampleOrg = DRY_RUN
    ? { id: 'dry-run-org', slug: ORG_SLUG }
    : await db.organization.upsert({
        where: { slug: ORG_SLUG },
        create: { slug: ORG_SLUG, name: ORG_NAME, createdById },
        update: { name: ORG_NAME },
        select: { id: true, slug: true },
      });

  // Ensure the sample "connection" exists so the app uses GL-based sample tables.
  if (DRY_RUN) {
    console.log(
      `[dry-run] Would upsert erpConnection org=${sampleOrg.slug} externalOrgId=${SAMPLE_EXT_ORG_ID}`,
    );
  } else {
    await db.erpConnection.upsert({
      where: {
        organizationId_provider_externalOrganizationId: {
          organizationId: sampleOrg.id,
          provider: 'XERO',
          externalOrganizationId: SAMPLE_EXT_ORG_ID,
        },
      },
      create: {
        organizationId: sampleOrg.id,
        provider: 'XERO',
        externalOrganizationId: SAMPLE_EXT_ORG_ID,
        displayName: ORG_NAME,
        accessTokenEncrypted: 'N/A',
        status: 'ACTIVE',
        createdById,
        metadata: { seeded: true, source: 'sample_gl_v2', orgName: ORG_NAME },
      },
      update: {
        displayName: ORG_NAME,
        status: 'ACTIVE',
        metadata: { seeded: true, source: 'sample_gl_v2', orgName: ORG_NAME },
      },
    });
  }

  // Ensure every demo user is a member of the shared org.
  for (const user of demoAppUsers) {
    if (DRY_RUN) {
      console.log(`[dry-run] Would upsert membership user=${user.email} org=${sampleOrg.slug}`);
    } else {
      await db.organizationMembership.upsert({
        where: {
          organizationId_userId: {
            organizationId: sampleOrg.id,
            userId: user.id,
          },
        },
        create: {
          organizationId: sampleOrg.id,
          userId: user.id,
          role: 'ADMIN',
          canViewDashboard: true,
          canCreateDashboard: true,
          canShareDashboard: true,
        },
        update: {
          role: 'ADMIN',
          canViewDashboard: true,
          canCreateDashboard: true,
          canShareDashboard: true,
          leftAt: null,
        },
      });
    }
  }

  // Optionally ensure demo users only have the shared org active.
  if (ONLY_SAMPLE_ORG) {
    for (const user of demoAppUsers) {
      if (DRY_RUN) {
        console.log(`[dry-run] Would set leftAt for non-sample memberships user=${user.email}`);
      } else {
        await db.organizationMembership.updateMany({
          where: { userId: user.id, organizationId: { not: sampleOrg.id }, leftAt: null },
          data: { leftAt: new Date() },
        });
      }
    }
  }

  console.log('✅ Done.');
}

main().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exitCode = 1;
});
