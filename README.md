# AFW Dataform — Transform Repo

Transform toàn bộ raw data từ Amazon (do C# sync services ghi vào) thành
các lớp flat → staging → fact trên BigQuery.

## Kiến trúc

```
C# Sync Services (Cloud Run)        Dataform (repo này)
─────────────────────────────       ─────────────────────────────────────
OrdersSync    (hourly)    ──→  afw_amazon_raw  ──→  afw_amazon_flat
InventorySync (daily)     ──→  afw_amazon_raw  ──→  afw_amazon_staging
SettlementSync(daily)     ──→  afw_amazon_raw  ──→  afw_amazon_fact
AdsSync       (daily)     ──→  afw_amazon_raw
ReturnsSync   (daily)     ──→  afw_amazon_raw
FeedbackSync  (weekly)    ──→  afw_amazon_raw
```

C# chỉ làm 1 việc: kéo data từ Amazon API → raw layer.
Dataform làm phần còn lại: raw → flat → staging → fact.

## Cấu trúc

```
definitions/
  flat/
    flat_amazon_orders.sqlx       ← parse JSON từ raw_amazon_order_report
    flat_amazon_inventory.sqlx    ← parse JSON từ raw_amazon_inventory
    flat_amazon_settlement.sqlx   ← parse JSON + xử lý local currency
    flat_amazon_ads.sqlx          ← parse JSON + tính sẵn ctr/cpc/roas
    flat_amazon_returns.sqlx      ← parse JSON từ raw_amazon_returns
  staging/
    stg_amazon_orders.sqlx        ← dedupe theo order_item_id
    stg_amazon_inventory.sqlx     ← dedupe theo (snapshot_date, sku)
    stg_amazon_settlement.sqlx    ← dedupe theo 7 cột composite key
    stg_amazon_ads.sqlx           ← dedupe theo (report_date, sku, campaign_id, ad_group_id)
    stg_amazon_returns.sqlx       ← dedupe theo (order_id, sku, return_date_raw, rma_id)
  fact/
    fact_sku_pnl_daily.sqlx       ← MERGE từ 4 staging tables, incremental 35 ngày
environments/
  dev.json                        ← allforwood-dev, dataset suffix _dev
  prod.json                       ← allforwood, không suffix
workflow_settings.yaml            ← config chính
```

## Dataset mapping

| Layer   | Dev                      | Prod                |
|---------|--------------------------|---------------------|
| Raw     | afw_amazon_raw_dev       | afw_amazon_raw      |
| Flat    | afw_amazon_flat_dev      | afw_amazon_flat     |
| Staging | afw_amazon_staging_dev   | afw_amazon_staging  |
| Fact    | afw_amazon_fact_dev      | afw_amazon_fact     |

Raw dataset KHÔNG được Dataform ghi vào — chỉ đọc từ đó.

## Setup trên Google Cloud Dataform

1. Tạo Dataform repository trong GCP Console:
   **BigQuery → Dataform → Create repository**
   - Region: asia-southeast1
   - Git provider: kết nối với repo Git chứa thư mục này

2. Tạo 2 compilation result configs:
   - `dev`: trỏ tới `environments/dev.json`
   - `prod`: trỏ tới `environments/prod.json`

3. Tạo Workflow config (schedule):
   - Trigger: sau khi SyncOrchestrator hoàn tất, hoặc đặt lịch riêng
     (ví dụ 7h sáng daily — sau SyncOrchestrator chạy 6h)
   - Tags: `daily` để chạy toàn bộ flat + staging + fact

## Dependency graph

Dataform tự quản lý thứ tự chạy dựa trên `ref()`:

```
raw_amazon_order_report
    └─→ flat_amazon_orders
            └─→ stg_amazon_orders
                    └─→ fact_sku_pnl_daily

raw_amazon_settlement
    └─→ flat_amazon_settlement
            └─→ stg_amazon_settlement
                    └─→ fact_sku_pnl_daily

raw_amazon_ads_performance
    └─→ flat_amazon_ads
            └─→ stg_amazon_ads
                    └─→ fact_sku_pnl_daily

raw_amazon_returns
    └─→ flat_amazon_returns
            └─→ stg_amazon_returns
                    └─→ fact_sku_pnl_daily

raw_amazon_inventory
    └─→ flat_amazon_inventory
            └─→ stg_amazon_inventory  (dùng riêng, không join vào fact)
```

## Lưu ý

- `fact_sku_pnl_daily` dùng `type: "incremental"` với `uniqueKey`
  — Dataform tự sinh MERGE statement, không cần viết tay.
- Flat và staging dùng `type: "table"` (CREATE OR REPLACE) — đơn giản,
  toàn bộ lịch sử được rebuild mỗi lần chạy.
- `raw_amazon_inventory` (FeedbackSync tables) không tham gia fact layer —
  phục vụ riêng cho Inventory Aging / Customer Insight reports.
