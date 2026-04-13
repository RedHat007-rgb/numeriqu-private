WITH raw_source AS (
    SELECT *
    FROM {{ source('quickbooks', 'quickbooks_raw') }}
    WHERE resource = 'Invoice'
)

SELECT
    -- Metadata
    tenant_id,
    user_id,
    connection_id,
    'quickbooks' AS provider,
    org_id,
    org_name,
    
    -- Core Identity
    source_id AS invoice_external_id,
    JSONExtractString(raw_data, 'DocNumber') AS invoice_number,
    
    -- Financials
    JSONExtractFloat(raw_data, 'TotalAmt') AS total_amount,
    JSONExtractString(raw_data, 'CurrencyRef', 'value') AS currency,
    
    -- Dates
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'TxnDate')) AS issued_at,
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'DueDate')) AS due_at,
    
    -- Status
    JSONExtractString(raw_data, 'EmailStatus') AS status,
    
    -- Audit
    updated_at,
    synced_at

FROM raw_source
