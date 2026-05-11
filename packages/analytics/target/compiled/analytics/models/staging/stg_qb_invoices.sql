WITH raw_source AS (
    SELECT *
    FROM `quickbooks`.`quickbooks_raw`
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
    JSONExtractFloat(raw_data, 'Balance') AS amount_due,
    (JSONExtractFloat(raw_data, 'TotalAmt') - JSONExtractFloat(raw_data, 'Balance')) AS amount_paid,
    0 AS amount_credited,
    JSONExtractString(raw_data, 'CurrencyRef', 'value') AS currency,
    
    -- Dates
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'TxnDate')) AS issued_at,
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'DueDate')) AS due_at,
    NULL AS paid_at,
    
    -- Status
    JSONExtractString(raw_data, 'EmailStatus') AS status,
    '' AS invoice_type,

    -- Client / contact
    JSONExtractString(raw_data, 'CustomerRef', 'value') AS contact_id,
    JSONExtractString(raw_data, 'CustomerRef', 'name') AS contact_name,
    
    -- Audit
    updated_at,
    synced_at

FROM raw_source