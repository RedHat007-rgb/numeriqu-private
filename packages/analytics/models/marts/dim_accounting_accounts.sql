{{ config(
    materialized='table',
    engine='MergeTree()',
    order_by=['user_id', 'account_type', 'account_external_id']
) }}

WITH xero AS (
    SELECT * FROM {{ ref('stg_xero_accounts') }}
),

qb AS (
    SELECT * FROM {{ ref('stg_qb_accounts') }}
),

unified AS (
    SELECT
        user_id,
        tenant_id,
        connection_id,
        provider,
        org_id,
        org_name,
        account_external_id,
        account_name,
        account_type,
        account_sub_type,
        classification,
        currency,
        is_active,
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
        account_external_id,
        account_name,
        account_type,
        account_sub_type,
        classification,
        currency,
        is_active,
        updated_at,
        synced_at
    FROM qb
)

SELECT
    -- Build a unique surrogate key for our warehouse
    generateUUIDv4() AS account_id,
    *
FROM unified
