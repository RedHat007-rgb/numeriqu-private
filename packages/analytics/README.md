# Numeriqu Analytics Transformation Layer (dbt)

This package contains the **Medallion Architecture** transformation logic for the Numeriqu platform. It takes raw data from various accounting providers (Xero, QuickBooks, etc.) and transforms it into unified, clean, and AI-ready datasets.

## Architecture

### 1. Unified Schema (Gold Layer)
We use a **Common Accounting Model (CAM)**. This ensures that whether data comes from Xero or QuickBooks, it is stored in a single, predictable table for your AI Agents and Dashboards.
- **Unified Invoices**: `analytics.fact_accounting_invoices`
- **Unified Accounts**: `analytics.dim_accounting_accounts`

### 2. AI & RAG Optimization
A special view `analytics.rag_context_invoices` is provided. This view flattens complex relational data into **Natural Language Strings** (e.g., "Invoice #123 is Overdue").
- **Benefit**: Your AI Agent only needs to query one string field to get full context, instead of doing complex joins.

### 3. Decoupling (Silver Layer)
Each provider has its own **Staging Model** (e.g., `stg_xero_invoices`).
- **Benefit**: If Xero changes their API field names tomorrow, you only update ONE staging file. Your AI Agents and Invoices Gold table will remain "blind" to the change and keep working perfectly.

## Security
- **Restricted Access**: The `dbt_transformer` user only has access to raw data and the `analytics` database.
- **App Consumer**: The `app_reader` user is restricted to the `analytics` database only, providing a hard security boundary between raw system data and user-facing dashboards.

## How to Run

1. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Configure (Optional)**:
   Ensure `profiles.yml` matches your ClickHouse host.

3. **Deploy Models**:
   ```bash
   dbt run
   ```

4. **Verify Data Quality**:
   ```bash
   dbt test
   ```
