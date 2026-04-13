

WITH xero AS (
    SELECT * FROM `analytics`.`stg_xero_invoices`
),

qb AS (
    SELECT * FROM `analytics`.`stg_qb_invoices`
),

unified AS (
    SELECT
        user_id,
        tenant_id,
        connection_id,
        provider,
        org_id,
        org_name,
        invoice_external_id,
        invoice_number,
        total_amount,
        currency,
        issued_at,
        due_at,
        status,
        updated_at,
        synced_at
    FROM xero
    
    UNION ALL
    
    SELECT
        user_id,
        tenant_id,
        connection_id,
        provider,
        org_id,
        org_name,
        invoice_external_id,
        invoice_number,
        total_amount,
        currency,
        issued_at,
        due_at,
        status,
        updated_at,
        synced_at
    FROM qb
)

SELECT
    -- Build a unique surrogate key for our warehouse
    generateUUIDv4() AS invoice_id,
    *
FROM unified