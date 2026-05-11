import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ErpProvider, Prisma } from "../generated/prisma/client";

type SheetDump = {
  headers: string[];
  records: Array<Record<string, unknown>>;
};

type ExtractedWorkbook = {
  sheets: Record<string, SheetDump>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prefer `packages/db/.env.local` (matches repo Prisma scripts), but also allow repo-root `.env.local`.
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });

async function getPrisma() {
  // Import after dotenv has loaded DATABASE_URL.
  const mod = await import("../src/client");
  return mod.prisma as typeof mod.prisma;
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function requiredArg(flag: string): string {
  const val = getArg(flag);
  if (!val) throw new Error(`Missing required argument: ${flag} <value>`);
  return val;
}

function normalizeProvider(provider: unknown): ErpProvider {
  const raw = String(provider ?? "").trim().toLowerCase();
  if (raw === "xero") return ErpProvider.XERO;
  if (raw === "quickbooks") return ErpProvider.QUICKBOOKS;
  throw new Error(`Unsupported provider value: ${String(provider)}`);
}

function toStringId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toBoolean(value: unknown, defaultValue = true): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (s === "") return defaultValue;
  if (["0", "false", "no", "n"].includes(s)) return false;
  if (["1", "true", "yes", "y"].includes(s)) return true;
  return Boolean(value);
}

function parseDateOnly(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function extractWorkbook(xlsxPath: string): ExtractedWorkbook {
  const extractorPath = path.resolve(__dirname, "extract_xlsx_json.py");
  if (!fs.existsSync(extractorPath)) {
    throw new Error(`Missing extractor script at ${extractorPath}`);
  }

  const res = spawnSync("python3", [extractorPath, xlsxPath], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`XLSX extract failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }

  return JSON.parse(res.stdout) as ExtractedWorkbook;
}

async function upsertTestUser(email: string) {
  const prisma = await getPrisma();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      email,
      fullName: "Test Data Importer",
      supabaseUserId: crypto.randomUUID(),
      isActive: true,
      isVerified: true,
    },
  });
}

async function upsertOrganization(slug: string, name: string, createdById: string) {
  const prisma = await getPrisma();
  return prisma.organization.upsert({
    where: { slug },
    create: {
      slug,
      name,
      createdById,
    },
    update: {
      name,
    },
  });
}

async function ensureMembership(organizationId: string, userId: string) {
  const prisma = await getPrisma();
  return prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: {
      organizationId,
      userId,
      role: "ADMIN",
      canViewDashboard: true,
      canCreateDashboard: true,
      canShareDashboard: true,
    },
    update: {
      role: "ADMIN",
      canViewDashboard: true,
      canCreateDashboard: true,
      canShareDashboard: true,
      leftAt: null,
    },
  });
}

async function upsertConnection(params: {
  organizationId: string;
  provider: ErpProvider;
  externalOrganizationId: string;
  displayName: string;
  createdById: string;
}) {
  const { organizationId, provider, externalOrganizationId, displayName, createdById } = params;
  const prisma = await getPrisma();
  return prisma.erpConnection.upsert({
    where: {
      organizationId_provider_externalOrganizationId: {
        organizationId,
        provider,
        externalOrganizationId,
      },
    },
    create: {
      organizationId,
      provider,
      externalOrganizationId,
      displayName,
      accessTokenEncrypted: `test_access_token:${externalOrganizationId}`,
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      status: "ACTIVE",
      createdById,
      metadata: {
        testData: true,
        externalOrganizationId,
      },
    },
    update: {
      displayName,
      status: "ACTIVE",
      metadata: {
        testData: true,
        externalOrganizationId,
      },
    },
  });
}

async function importAccounts(args: {
  organizationId: string;
  connectionId: string;
  records: Array<Record<string, unknown>>;
}) {
  const { organizationId, connectionId, records } = args;
  const prisma = await getPrisma();
  let written = 0;

  for (const rec of records) {
    const accountCode = toStringId(rec["account_external_id"]);
    if (!accountCode) continue;
    const accountName = toStringId(rec["account_name"]) || accountCode;
    const accountType = toStringId(rec["account_type"]) || "UNKNOWN";
    const currencyCode = toStringId(rec["currency"]) || null;
    const isActive = toBoolean(rec["is_active"], true);

    await prisma.financialAccount.upsert({
      where: {
        organizationId_connectionId_accountCode: {
          organizationId,
          connectionId,
          accountCode,
        },
      },
      create: {
        organizationId,
        connectionId,
        accountCode,
        accountName,
        accountType,
        currencyCode,
        isActive,
      },
      update: {
        accountName,
        accountType,
        currencyCode,
        isActive,
      },
    });
    written += 1;
  }

  return { written };
}

async function importInvoices(args: {
  organizationId: string;
  connectionId: string;
  records: Array<Record<string, unknown>>;
}) {
  const { organizationId, connectionId, records } = args;
  const prisma = await getPrisma();
  let written = 0;

  for (const rec of records) {
    const invoiceNumber = toStringId(rec["invoice_number"]) || toStringId(rec["invoice_external_id"]);
    if (!invoiceNumber) continue;
    const currencyCode = (toStringId(rec["currency"]) || "USD").slice(0, 3).toUpperCase();
    const issueDate = parseDateOnly(rec["issued_at"]);
    if (!issueDate) continue;
    const dueDate = parseDateOnly(rec["due_at"]);
    const status = toStringId(rec["status"]) || "UNKNOWN";
    const totalAmountRaw = rec["total_amount"];
    const totalAmount = new Prisma.Decimal(totalAmountRaw === null || totalAmountRaw === undefined ? 0 : String(totalAmountRaw));

    await prisma.financialInvoice.upsert({
      where: {
        organizationId_connectionId_invoiceNumber: {
          organizationId,
          connectionId,
          invoiceNumber,
        },
      },
      create: {
        organizationId,
        connectionId,
        counterpartyId: null,
        invoiceNumber,
        invoiceType: "INVOICE",
        status,
        currencyCode,
        issueDate,
        dueDate,
        subtotalAmount: totalAmount,
        taxAmount: new Prisma.Decimal(0),
        totalAmount,
        amountPaid: new Prisma.Decimal(0),
        amountDue: totalAmount,
        sourceUpdatedAt: null,
        deletedAt: null,
      },
      update: {
        status,
        currencyCode,
        issueDate,
        dueDate,
        subtotalAmount: totalAmount,
        totalAmount,
        amountDue: totalAmount,
      },
    });
    written += 1;
  }

  return { written };
}

async function main() {
  const prisma = await getPrisma();
  const filePath = requiredArg("--file");
  const orgSlug = getArg("--org-slug") ?? "tenant-1";
  const orgName = getArg("--org-name") ?? "Tenant 1";
  const userEmail = getArg("--user-email") ?? "test-data-importer@example.com";
  const dryRun = hasFlag("--dry-run");
  const allowRemote = hasFlag("--allow-remote");

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Create packages/db/.env.local with DATABASE_URL (and DIRECT_URL if needed), or export DATABASE_URL before running.",
    );
  }

  const dbUrl = new URL(process.env.DATABASE_URL);
  const dbHost = (dbUrl.hostname || "").toLowerCase();
  const isLocalHost = dbHost === "localhost" || dbHost === "127.0.0.1";
  if (!isLocalHost && !allowRemote) {
    throw new Error(
      `Refusing to write to non-local database host (${dbHost}). Re-run with --allow-remote if this is intentional.`,
    );
  }

  const absFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absFilePath)) throw new Error(`XLSX not found: ${absFilePath}`);

  const wb = extractWorkbook(absFilePath);

  const xeroSheet = wb.sheets["test_data_xero"]?.records ?? [];
  const qbSheet = wb.sheets["test_data_quickbooks"]?.records ?? [];
  const qbInvoicesSheet = wb.sheets["test_data_quickbooks_invoices"]?.records ?? [];

  if (xeroSheet.length === 0 && qbSheet.length === 0 && qbInvoicesSheet.length === 0) {
    throw new Error(
      "No expected sheets found. Expected sheets: test_data_xero, test_data_quickbooks, test_data_quickbooks_invoices",
    );
  }

  const user = await upsertTestUser(userEmail);
  const org = await upsertOrganization(orgSlug, orgName, user.id);
  await ensureMembership(org.id, user.id);

  const results: Record<string, unknown> = { organizationId: org.id, userId: user.id };

  if (!dryRun && xeroSheet.length > 0) {
    const provider = normalizeProvider(xeroSheet[0]?.["provider"]);
    const conn = await upsertConnection({
      organizationId: org.id,
      provider,
      externalOrganizationId: "test_data_xero",
      displayName: "test_data_xero",
      createdById: user.id,
    });
    results["test_data_xero_connectionId"] = conn.id;
    results["test_data_xero_accounts"] = await importAccounts({
      organizationId: org.id,
      connectionId: conn.id,
      records: xeroSheet,
    });
  }

  if (!dryRun && qbSheet.length > 0) {
    const provider = normalizeProvider(qbSheet[0]?.["provider"]);
    const conn = await upsertConnection({
      organizationId: org.id,
      provider,
      externalOrganizationId: "test_data_quickbooks",
      displayName: "test_data_quickbooks",
      createdById: user.id,
    });
    results["test_data_quickbooks_connectionId"] = conn.id;
    results["test_data_quickbooks_accounts"] = await importAccounts({
      organizationId: org.id,
      connectionId: conn.id,
      records: qbSheet,
    });

    if (qbInvoicesSheet.length > 0) {
      results["test_data_quickbooks_invoices"] = await importInvoices({
        organizationId: org.id,
        connectionId: conn.id,
        records: qbInvoicesSheet,
      });
    }
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const prisma = await getPrisma();
    await prisma.$disconnect();
  });
