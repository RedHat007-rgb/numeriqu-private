-- Per-org embedded Power BI report URL, surfaced in the dashboard sidebar.
-- De-hardcodes the compiled-in POWER_BI_URL literal (one tenant's report shown
-- to every org) into config-as-data. Additive + nullable ⇒ safe, no backfill.

ALTER TABLE "organizations" ADD COLUMN "power_bi_url" TEXT;
