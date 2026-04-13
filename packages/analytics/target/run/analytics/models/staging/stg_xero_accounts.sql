

  create or replace view `analytics`.`stg_xero_accounts` 
  
    
  
  
    
    
  as (
    WITH raw_source AS (
    SELECT *
    FROM `xero_custom`.`xero_raw`
    WHERE resource = 'Accounts'
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
    source_id AS account_external_id,
    JSONExtractString(raw_data, 'name') AS account_name,
    JSONExtractString(raw_data, 'type') AS account_type,
    JSONExtractString(raw_data, '_class') AS account_sub_type,
    
    -- Classification
    CASE 
        WHEN JSONExtractString(raw_data, '_class') IN ('ASSET', 'LIABILITY', 'EQUITY', 'Asset', 'Liability', 'Equity') THEN 'BalanceSheet'
        ELSE 'ProfitAndLoss'
    END AS classification,
    JSONExtractString(raw_data, 'currencyCode') AS currency,
    
    -- Status
    CASE WHEN JSONExtractString(raw_data, 'status') IN ('ACTIVE', 'Active') THEN true ELSE false END AS is_active,
    
    -- Audit
    updated_at,
    synced_at

FROM raw_source
    
  )
      
      
                    -- end_of_sql
                    
                    