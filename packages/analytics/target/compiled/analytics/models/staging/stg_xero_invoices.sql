WITH raw_source AS (
    SELECT *
    FROM `xero_custom`.`xero_raw`
    WHERE resource = 'Invoices'
)

SELECT
    -- Metadata
    tenant_id,
    user_id,
    connection_id,
    'xero' AS provider,
    org_id,
    org_name,
    
    -- Core Identity
    source_id AS invoice_external_id,
    JSONExtractString(raw_data, 'invoiceNumber') AS invoice_number,
    
    -- Financials
    JSONExtractFloat(raw_data, 'total') AS total_amount,
    JSONExtractString(raw_data, 'currencyCode') AS currency,
    
    -- Dates
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'date')) AS issued_at,
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'dueDate')) AS due_at,
    
    -- Status
    JSONExtractString(raw_data, 'status') AS status,
    
    -- Audit
    updated_at,
    synced_at

FROM raw_source