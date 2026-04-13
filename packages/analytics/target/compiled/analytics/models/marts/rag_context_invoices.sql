

WITH invoices AS (
    SELECT * FROM `analytics`.`fact_accounting_invoices`
)

SELECT
    invoice_id,
    user_id,
    tenant_id,
    provider,
    org_id,
    org_name,
    -- This is the "Gold" for RAG. A pre-built context string.
    -- Example: "Invoice #INV-100 from Xero for $1,250.00 USD is currently OVERDUE. Issued on 2023-01-01, due on 2023-01-15."
    concat(
        'Invoice #', invoice_number, 
        ' for ', org_name, ' (', upper(substring(provider, 1, 1)), substring(provider, 2), ')',
        ' for ', toString(total_amount), ' ', currency, 
        ' is currently ', IF(status = '', 'UNKNOWN', status),
        '. Issued on ', toString(toDate(issued_at)), 
        ', due on ', toString(toDate(due_at)), '.'
    ) AS text_content,
    
    -- Original fields for metadata filtering in Vector Stores
    total_amount,
    currency,
    status,
    issued_at,
    due_at
FROM invoices