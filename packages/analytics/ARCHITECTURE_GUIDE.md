# 🏗️ Numeriqu Transformation Architecture Guide
> **"Turning Raw Data into Pure Gold"**

Welcome to the heart of the Numeriqu Data Engine. This guide explains how we take messy financial data from different providers (like Xero and QuickBooks) and turn it into a single, high-performance "Source of Truth" for our AI Agents and Dashboards.

---

## 🧸 The "Toy Factory" Analogy (The Medallion Architecture)

Think of your data like a giant **Toy Factory**. 

### 🏚️ Step 1: The BRONZE Layer (Raw & Messy)
*   **The Story**: Toys arrive in messy boxes by the truckload. Some boxes are labeled "Name", some are "name", and some are just full of random text.
*   **What we do**: We don't change anything! We just put the boxes in the warehouse exactly as they arrived. This way, if we ever make a mistake, we can go back and look at the original box.
*   **Where it is**: `xero_custom.xero_raw` and `quickbooks.quickbooks_raw`.

### 🧼 Step 2: The SILVER Layer (Cleaning & Sorting)
*   **The Story**: This is the "Cleaning Station". We take the toys out of the messy boxes, wash them, and put new, clear stickers on them.
*   **What we do**: We fix the "name" vs "Name" issues. We make sure all numbers look like numbers. We sort the toys into piles (Invoices, Accounts, etc.).
*   **Where it is**: `analytics.stg_xero_accounts`, `analytics.stg_qb_accounts`, etc.

### 🏆 Step 3: The GOLD Layer (The Shiny Toy Store)
*   **The Story**: This is the finished product. We take the clean toys and put them on one beautiful, golden shelf.
*   **What we do**: We merge everything! Instead of having two shelves (Xero/QuickBooks), we have ONE shelf called "Accounting". 
*   **Where it is**: `analytics.dim_accounting_accounts` and `analytics.fact_accounting_invoices`.

---

## 📖 The Data Dictionary (What each key does)

Every record on our "Gold Shelf" has these important keys. Here is why they are there:

### 🆔 Identity Keys
| Column Name | Technical Meaning | Layman Meaning |
| :--- | :--- | :--- |
| **`account_id`** | Primary UUID | A unique "Passport Number" we gave the record. |
| **`user_id`** | Owner ID | The name of the Person who owns this data. |
| **`tenant_id`** | Multi-Tenant ID | The "VIP Box" it belongs to. Ensures no cross-talk between customers. |
| **`provider`** | Source Provider | Did this toy come from Xero Island or QuickBooks Kingdom? |

### 📈 Business Keys
| Column Name | Technical Meaning | Layman Meaning |
| :--- | :--- | :--- |
| **`account_name`** | Standardized Name | The human name (like "Main Savings") that people understand. |
| **`account_type`** | Accounting Category | Is this a Bank Account, a Revenue account, or a Bill? |
| **`classification`** | P&L / Balance Sheet | Does the record tell us how much we made, or what we own? |
| **`r_rag_context`** | AI Context String | A "Short Story" about the record that an AI can read and understand instantly. |

---

## 🤖 Why this is the "Best in the World" for AI
Our Gold Layer contains a special view called **`rag_context_invoices`**. 

Instead of forcing your AI Agent to learn a complex SQL database, we give it a simple **Story**. 
> **Example**: "Invoice #789 from Xero is for $2,500.00 and is currently OVERDUE."

Because the AI reads this story, its answers are 10x more accurate and much faster.

---

## 🛠️ How to run the Factory
If you add more data, just run these two commands in the `packages/analytics` folder:
1. `export $(grep -v '^#' .env | xargs)` (Turn on the power)
2. `./dbt_venv/bin/dbt run` (Run the factory)

---

