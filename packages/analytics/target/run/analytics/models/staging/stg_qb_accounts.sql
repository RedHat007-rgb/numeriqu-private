

  create or replace view `analytics`.`stg_qb_accounts` 
  
    
  
  
    
    
  as (
    WITH raw_source AS (
    SELECT *
    FROM `quickbooks`.`quickbooks_raw`
    WHERE resource = 'Account'
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
    source_id AS account_external_id,
    JSONExtractString(raw_data, 'Name') AS account_name,
    JSONExtractString(raw_data, 'AccountType') AS account_type,
    JSONExtractString(raw_data, 'AccountSubType') AS account_sub_type,
    
    -- Classification
    JSONExtractString(raw_data, 'Classification') AS classification,
    JSONExtractString(raw_data, 'CurrencyRef', 'value') AS currency,
    
    -- Status
    JSONExtractBool(raw_data, 'Active') AS is_active,
    
    -- Audit
    updated_at,
    synced_at

FROM raw_source
    
  )
      
      
                    -- end_of_sql
                    
                    