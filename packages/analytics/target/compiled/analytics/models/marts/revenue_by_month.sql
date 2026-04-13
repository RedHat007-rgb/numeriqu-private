

SELECT
    toStartOfMonth(issued_at) as month,
    currency,
    SUM(total_amount) as total_revenue,
    tenant_id,
    provider,
    org_id,
    org_name
FROM `analytics`.`fact_accounting_invoices`
WHERE status IN ('AUTHORISED', 'PAID', 'Paid', 'Closed', 'NotSet', 'NeedToSend')
GROUP BY month, currency, tenant_id, provider, org_id, org_name
ORDER BY month ASC