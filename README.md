# AFW Dataform — Transform Repo

Transform raw data từ Amazon (do C# sync services ghi vào) thành staging
và fact/master trên BigQuery.

## Kiến trúc — 3 lớp (đã gộp flat vào staging)

```
C# Sync Services (Cloud Run)        Dataform (repo này)
─────────────────────────────       ─────────────────────────────────────
OrdersSync    (hourly)    ──→  afw_amazon_raw  ──→  afw_amazon_staging
InventorySync (daily)     ──→  afw_amazon_raw  ──→       │
SettlementSync(daily)     ──→  afw_amazon_raw  ──→       ├──→ afw_amazon_fact
ReturnsSync   (daily)     ──→  afw_amazon_raw  ──→       └──→ master_amazon_*
FeedbackSync  (weekly)    ──→  afw_amazon_raw
```

**Amazon Ads ĐÃ TÁCH RIÊNG** sang project độc lập (`AfwAdsSync` C# +
`AfwAdsDataform`) — không còn nằm trong sơ đồ này. Lý do: hệ OAuth khác
hẳn (LWA riêng), và Ads API key đang bị chặn (chưa có). Xem README của
2 repo đó để biết chi tiết, và mục "JOIN cross-project" dưới đây nếu cần
ghép P&L có Ads.

C# chỉ làm 1 việc: kéo data từ Amazon API → raw layer.
Dataform làm phần còn lại: raw → staging → fact & master.

Mỗi file staging gộp 2 bước trong 1 SQLX (trước đây tách riêng flat +
staging, giờ gộp vì logic xử lý gần nhau):
  1. **parsed CTE** — parse JSON từ raw_payload thành cột riêng
  2. **ranked CTE** — dedupe bằng ROW_NUMBER() theo composite key

## Cấu trúc

```
definitions/
  staging/
    stg_amazon_orders.sqlx        ← parse + dedupe theo order_item_id
    stg_amazon_inventory.sqlx     ← parse + dedupe theo (snapshot_date, sku)
    stg_amazon_settlement.sqlx    ← parse + local currency + dedupe 7 cột
    stg_amazon_returns.sqlx       ← parse + dedupe theo (order_id, sku, return_date, rma_id)
  fact/
    fact_sku_pnl_daily.sqlx       ← MERGE từ 3 staging (Orders/Settlement/
                                     Returns), incremental 35 ngày. Ads
                                     KHÔNG còn join vào đây.
  master/
    master_amazon_orders.sqlx     ← giữ TOÀN BỘ lịch sử order, UPDATE khi
                                     last_updated_date mới hơn (audit trail)
    master_amazon_settlement.sqlx ← giữ TOÀN BỘ giao dịch settlement,
                                     INSERT-ONLY (giao dịch coi là bất biến)
    master_amazon_returns.sqlx    ← giữ TOÀN BỘ lần trả hàng, UPDATE khi
                                     _ingested_at mới hơn (status có thể đổi)
    master_amazon_inventory.sqlx  ← version theo NGÀY, ghi đè trong cùng
                                     ngày, giữ lại version khi qua ngày mới
  sources/
    sources.js                    ← declare() 11 raw tables
environments/
  dev.json / prod.json
workflow_settings.yaml
```

## Dataset mapping

| Layer   | Dev                      | Prod                |
|---------|---------------------------|---------------------|
| Raw     | afw_amazon_raw_dev        | afw_amazon_raw      |
| Staging | afw_amazon_staging_dev    | afw_amazon_staging  |
| Fact    | afw_amazon_fact_dev       | afw_amazon_fact     |
| Master  | afw_amazon_fact_dev       | afw_amazon_fact     |

Raw dataset KHÔNG được Dataform ghi vào — chỉ đọc từ đó.

## Dependency graph

```
raw_amazon_order_report
    └─→ stg_amazon_orders
            ├─→ fact_sku_pnl_daily
            └─→ master_amazon_orders

raw_amazon_settlement
    └─→ stg_amazon_settlement
            ├─→ fact_sku_pnl_daily
            └─→ master_amazon_settlement

raw_amazon_returns
    └─→ stg_amazon_returns
            ├─→ fact_sku_pnl_daily
            └─→ master_amazon_returns

raw_amazon_inventory
    └─→ stg_amazon_inventory
            ├─→ master_amazon_inventory
            └─→ (KHÔNG join vào fact_sku_pnl_daily)
```

## fact_sku_pnl_daily — tổng hợp theo ngày

`type: "incremental"`, `uniqueKey: [brand, channel, sku, day]`. Mỗi lần
chạy chỉ tính lại 35 ngày gần nhất (bắt kịp settlement post trễ), MERGE
ghi đè — không cần lịch sử thay đổi, chỉ cần số liệu mới nhất mỗi ngày.

CHƯA gồm Ads (đã tách project riêng) — `channel_contribution_margin_pre_cogs`
ở đây chỉ trừ commission/FBA fee/storage fee, KHÔNG trừ ad_spend.

## JOIN với Ads (cross-project) — nếu cần P&L có Ads

Vì Ads nằm ở project Dataform riêng (`AfwAdsDataform`), muốn xem P&L tổng
có cả Ads phải JOIN thủ công qua cross-project query trong BigQuery
Console hoặc 1 view riêng:

```sql
SELECT
  p.brand, p.sku, p.day,
  p.gross_revenue, p.commission_fee, p.fba_fulfillment_fee,
  a.ad_spend, a.ad_attributed_sales,
  p.channel_contribution_margin_pre_cogs - COALESCE(a.ad_spend, 0)
    AS channel_contribution_margin_with_ads
FROM `allforwood-dev.afw_amazon_fact_dev.fact_sku_pnl_daily` p
LEFT JOIN `allforwood-dev.afw_amazon_ads_fact_dev.fact_ads_performance_daily` a
  ON p.brand = a.brand AND p.sku = a.sku AND p.day = a.day
```

## Lớp Master — audit trail giữ lịch sử thay đổi

4 bảng `master_amazon_*` đều `type: "incremental"`, KHÔNG bị xóa làm lại
mỗi lần chạy (khác staging) — nhưng khác nhau về điều kiện UPDATE:

| Bảng | uniqueKey | Điều kiện UPDATE | Lý do |
|---|---|---|---|
| `master_amazon_orders` | `order_item_id` | `last_updated_date` mới hơn | Amazon có cột nghiệp vụ riêng cho việc này |
| `master_amazon_settlement` | 6 cột composite | KHÔNG có UPDATE — INSERT-ONLY | Giao dịch settlement coi là bất biến sau khi ghi nhận |
| `master_amazon_returns` | `amazon_order_id, sku, return_date_raw, rma_id` | `_ingested_at` mới hơn | `return_status`/`resolution` có thể đổi qua các giai đoạn xử lý (Requested → Received → Refunded) |
| `master_amazon_inventory` | `snapshot_date, sku` | Tự động qua uniqueKey, không cần điều kiện phụ | Cùng ngày → ghi đè (chỉ giữ bản mới nhất trong ngày); khác ngày → version riêng |

Cơ chế chung (3 bảng đầu): self-join với chính bảng master, chỉ đưa vào
MERGE những dòng thỏa điều kiện UPDATE hoặc chưa từng tồn tại — dòng không
đổi sẽ không xuất hiện trong USING clause của MERGE, giữ nguyên 100% giá
trị cũ.

`master_amazon_inventory` đơn giản hơn — vì `snapshot_date` đã nằm trong
`uniqueKey`, MERGE tự xử lý đúng ý nghĩa "version theo ngày" mà không cần
logic so sánh thời gian thêm.

## Lưu ý quan trọng — parse JSON timestamp

Dùng `SAFE_CAST(... AS TIMESTAMP)` thay cho `PARSE_TIMESTAMP` với format
string cố định (`%Ez`). Lý do: Amazon trả ISO 8601 chuẩn với offset dạng
`+00:00` (có dấu hai chấm), nhưng `%Ez` khi PARSE đòi hỏi `+0000` (không
dấu hai chấm) — gây parse fail âm thầm, trả NULL cho toàn bộ cột.
`SAFE_CAST AS TIMESTAMP` tự nhận diện mọi biến thể ISO 8601 hợp lệ.

## Setup trên Google Cloud Dataform

Xem hướng dẫn đầy đủ trong lịch sử trao đổi — tóm tắt:
1. Push code lên GitHub
2. Tạo GitHub PAT, lưu vào Secret Manager
3. Enable Dataform API, tạo custom service account
4. Tạo Dataform repository (region us-central1, defaultLocation US)
5. Gán quyền service agent đọc Secret Manager
6. Kết nối GitHub, tạo workspace, compile test
7. Tạo Workflow Configuration chạy daily (sau SyncOrchestrator 6h sáng)
