

  create or replace view `analytics`.`stg_xero_invoices` 
  
    
  
  
    
    
  as (
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
    JSONExtractFloat(raw_data, 'amountDue') AS amount_due,
    JSONExtractFloat(raw_data, 'amountPaid') AS amount_paid,
    JSONExtractFloat(raw_data, 'amountCredited') AS amount_credited,
    JSONExtractString(raw_data, 'currencyCode') AS currency,
    
    -- Dates
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'date')) AS issued_at,
    parseDateTimeBestEffort(JSONExtractString(raw_data, 'dueDate')) AS due_at,
    parseDateTimeBestEffortOrNull(JSONExtractString(raw_data, 'fullyPaidOnDate')) AS paid_at,
    
    -- Status
    JSONExtractString(raw_data, 'status') AS status,
    JSONExtractString(raw_data, 'type') AS invoice_type,

    -- Client / contact (robust to casing / SDK variations)
    coalesce(
      nullIf(JSONExtractString(raw_data, 'contact', 'contactID'), ''),
      nullIf(JSONExtractString(raw_data, 'contact', 'contactId'), ''),
      nullIf(JSONExtractString(raw_data, 'Contact', 'ContactID'), ''),
      nullIf(JSONExtractString(raw_data, 'Contact', 'contactID'), ''),
      nullIf(JSONExtractString(raw_data, 'Contact', 'contactId'), '')
    ) AS contact_id,
    coalesce(
      nullIf(JSONExtractString(raw_data, 'contact', 'name'), ''),
      nullIf(JSONExtractString(raw_data, 'contact', 'Name'), ''),
      nullIf(JSONExtractString(raw_data, 'Contact', 'Name'), ''),
      nullIf(JSONExtractString(raw_data, 'Contact', 'name'), '')
    ) AS contact_name,
    
    -- Audit
    updated_at,
    synced_at

FROM raw_source
    
  )
      
      
                    -- end_of_sql
                    
                    