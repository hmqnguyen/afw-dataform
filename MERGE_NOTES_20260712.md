# AFW Amazon — Merge Handoff-2 × Patch Audit-B (2026-07-12)

Quyết định đã chốt: **Q1** giữ retention raw 90 ngày · **Q2 (A)** `settlement_key` hash NULL-safe · **Q3** watermark `_ingested_at` · **F9 (A)** không phân bổ ads/storage xuống SKU

---

## 1. Merge có xung đột không?

**Không.** Handoff-2 sửa **4 file staging**; Patch B sửa **7 file khác**. Giao nhau = ∅.

| Handoff-2 sửa | Downstream | An toàn? |
|---|---|---|
| `stg_amazon_settlement_fees` (taxonomy bug #10) | `master_amazon_settlement_fees` = `type: table` + `SELECT *` | ✅ tự thích ứng |
| `stg_amazon_inventory` (+4 cột, bug #8) | `master_amazon_inventory` = `type: table` | ✅ |
| `stg_amazon_listings` (open_date + 5 cột, bug #9) | `master_amazon_listings` = `type: table`; `mart_amazon_listing_price_monitor` chọn cột tường minh | ✅ |
| `stg_amazon_inventory_ledger` | chỉ thêm comment, SQL không đổi | ✅ |

`AfwAmazonSync_restructured.zip`, `sql/*`, `docs/*` — **không đổi** giữa 2 handoff.

---

## 2. Trạng thái repo sau merge

```
staging     12   (4 file từ handoff-2 + stg_amazon_settlement từ patch B)
master      12   (4 file patch B)
fact         1   (patch B + F9)
mart         5   (+ mart_amazon_channel_pnl_monthly MỚI)
assertions   2   (+ assert_settlement_fees_no_unmapped MỚI)
```
✅ Static check: **mọi `ref()` đều resolve**, không có object treo.

---

## 3. Lỗi & file vá — bảng hợp nhất

| # | Lỗi | Nguồn | File |
|---|---|---|---|
| F1 | Raw S&T `PARTITION BY report_date` + expiration 90d → tự xoá backfill | Audit B | `sql/migrate_sales_traffic_raw_partition.sql` |
| F2 | `--full-refresh` + raw 90d → xoá vĩnh viễn lịch sử | Audit B | `sql/backup_before_full_refresh.sql` |
| F3 | `master_amazon_orders`: pre_operations 32 vs SELECT 35 cột | Audit B | `master/master_amazon_orders.sqlx` |
| F3b | `master_amazon_sales_traffic_by_date`: thiếu `_ingested_at` | Audit B | `master/..._by_date.sqlx` |
| F4/F4b | `fact`: `DECLARE` sai chỗ + **hai** mệnh đề `WHERE` | Audit B | `fact/fact_sku_pnl_daily.sqlx` |
| F5 | Settlement: MERGE key NULL-unsafe + lệch khoá staging↔master | Audit B | `staging/stg_amazon_settlement.sqlx` + `master/master_amazon_settlement.sqlx` |
| F6 | Master S&T lọc `report_date >= -35d` → chặn backfill/vá thủng | Audit B | `master/..._by_asin.sqlx` + `..._by_date.sqlx` |
| F7 | `mart_traffic_conversion`: `stock` thiếu `WHERE is_latest` | Audit B | `mart/mart_amazon_traffic_conversion.sqlx` |
| **F8** | **`IFNULL(available_qty,0)` → 144 SKU FBM bị chẩn đoán STOCKOUT GIẢ** | **Merge** | `mart/mart_amazon_traffic_conversion.sqlx` |
| **F9** | **`fact.storage_fee` LUÔN = 0; margin thiếu ads (−$104,679) + storage** | **Merge** | `fact/` + `mart/mart_amazon_channel_pnl_monthly.sqlx` (mới) |
| #8/#9/#10 | inventory 4 cột · listings `open_date` · taxonomy ad spend | Handoff-2 | 4 staging (giữ nguyên) |

**Đã đóng:** ✅ G6 (CVR đúng sẵn) · ✅ disposition trong storage mart (cố ý cộng tất cả — handoff-2 xác nhận) · ✅ `in_transit` không tính phí kho (mart dùng `ending_balance`, đã loại sẵn)

---

## 4. F8 — STOCKOUT giả (chi tiết)

`stock` đọc `master_amazon_inventory_planning` = report **FBA-only**. 144/246 listing là **FBM** → không có dòng ở đó → `LEFT JOIN` ra NULL → `IFNULL(...,0)` → `available_qty = 0` → `root_cause = 'STOCKOUT'`.

**Vá:** giữ NULL. `NULL = 0` → UNKNOWN → nhánh STOCKOUT không fire → SKU FBM rơi xuống các nhánh chẩn đoán bình thường. Thêm cột `not_in_fba_inventory` để biết dòng nào **không được kiểm tra tồn kho**.

> ⚠️ **Lỗ hổng còn lại:** SKU FBM hết hàng ở Lecangs → mart này **không phát hiện được**. Cần nguồn tồn kho FBM (Lecangs / Castlegate) mới bịt được. Đây là ràng buộc dữ liệu, không phải bug code.

> ⚠️ **Tuyệt đối không "chuẩn hoá" SKU để ép join** (I5). Bằng chứng handoff-2: `amzn.gr.FBA-200100-xxx` là **23 listing THẬT**; `FBA -815250` ≠ `FBA- 815250` (2 SKU riêng, tồn kho riêng).

---

## 5. F9 — kiến trúc ads/storage (quyết định A)

```
fact_sku_pnl_daily          grain: SKU × ngày   KHÔNG có ads/storage/freight
                            → channel_contribution_margin_pre_cogs_PRE_ADS_PRE_STORAGE
                              (tên nói thẳng cái nó thiếu)

mart_amazon_channel_pnl_monthly   grain: tháng × kênh   CÓ ads/storage/freight
                            → cm1_pre_ads · cm2_post_ads_pre_cogs
                            → ad_spend_pct_of_cm1  ← chỉ số quan trọng nhất
```

**Lý do không phân bổ ads xuống SKU:** ad spend có **0 dòng có SKU**. Chia theo doanh thu = SKU organic bị gánh oan, SKU chạy ads nặng được gánh nhẹ → **sai ngược chiều với quyết định thật** (bật/tắt ads SKU nào). Muốn ad spend theo SKU → bắt buộc Advertising API.

**Storage:** giữ nguyên `mart_sku_storage_allocated` (driver **vật lý** cubic-foot-days — chính đáng). Chưa join vào fact; sẽ join khi làm Cost Allocation Engine.

**`fact.storage_fee` giữ lại nhưng KHÔNG vào công thức margin** — nó là chốt bảo vệ: nếu ngày nào đó `SUM(storage_fee) != 0` ⇒ Amazon đã đổi cách post phí ⇒ phải rà lại `mart_sku_storage_allocated`.

---

## 6. Thứ tự thực thi

```bash
# 0. Vá raw S&T — làm TRƯỚC, mỗi ngày trôi là mất thêm data
bq --project_id=allforwood-dev query --use_legacy_sql=false --location=US \
   < sql/migrate_sales_traffic_raw_partition.sql
#    → DỪNG, đối soát n_old = n_new → bỏ comment phần SWAP → chạy lại
#    → cập nhật create_raw_tables_amazon.sql (dòng ~229, ~245)

# 1. Backup — BẮT BUỘC trước --full-refresh
bq ... < sql/backup_before_full_refresh.sql

# 2. Áp repo
cd ~/path/to/afw-dataform
cp -r <merged>/definitions/. definitions/
git checkout -b amazon-merge-auditB-20260712
git add -A && git commit -m "Amazon: merge handoff-2 (bug #8/#9/#10) + audit B (F1-F9)"

# 3. COMPILE ≠ EXECUTE — phải tạo compilation result MỚI
dataform compile --project-dir . --json | grep -i error    # phải rỗng

# 4. Full-refresh (schema đổi: settlement_key, _ingested_at, +3 cột orders,
#    +4 cột inventory, +5 cột listings, cột margin đổi tên)
dataform run --full-refresh --tags staging --environment dev
dataform run --full-refresh --tags master  --environment dev
dataform run --environment dev

# 5. Đối soát mất data (query cuối backup_before_full_refresh.sql)

# 6. Vá 3 ngày S&T — giờ mới có tác dụng, nhờ F6
dotnet run --project services/SalesTrafficSync -- --local --start 2026-04-16 --end 2026-04-16
dotnet run --project services/SalesTrafficSync -- --local --start 2026-05-10 --end 2026-05-10
dotnet run --project services/SalesTrafficSync -- --local --start 2026-07-02 --end 2026-07-02
dataform run --environment dev
```

---

## 7. Query kiểm chứng

```sql
-- #10 (taxonomy): UNMAPPED phải = 0. Ad spend phải ≈ −$104,679.
SELECT cost_group, COUNT(*) n, ROUND(SUM(amount), 2) total
FROM `afw_amazon_master.master_amazon_settlement_fees`
GROUP BY 1 ORDER BY 3;

-- F9: storage_fee cấp SKU phải = 0 (nếu khác 0 → Amazon đổi cách post phí)
SELECT ROUND(SUM(storage_fee), 2) AS must_be_zero
FROM `afw_amazon_fact.fact_sku_pnl_daily`;

-- F9: ads ăn bao nhiêu % CM1 (kỳ vọng ~79%)
SELECT month, cm1_pre_ads, ad_spend, ad_spend_pct_of_cm1, cm2_post_ads_pre_cogs, taxonomy_health
FROM `afw_amazon_mart.mart_amazon_channel_pnl_monthly` ORDER BY month DESC;

-- F8: SKU nào KHÔNG được kiểm tra tồn kho (FBM) — không được có STOCKOUT
SELECT root_cause, COUNTIF(not_in_fba_inventory) n_not_fba, COUNT(*) n_total
FROM `afw_amazon_mart.mart_amazon_traffic_conversion` GROUP BY 1;
-- kỳ vọng: root_cause='STOCKOUT' → n_not_fba = 0

-- F5: settlement không được trùng settlement_key
SELECT settlement_key, COUNT(*) n
FROM `afw_amazon_master.master_amazon_settlement` GROUP BY 1 HAVING n > 1;   -- kỳ vọng 0 dòng

-- F5: các dòng order-id NULL (nếu có) phải phân biệt được
SELECT COUNT(*) n_rows, COUNT(DISTINCT settlement_key) n_keys
FROM `afw_amazon_master.master_amazon_settlement` WHERE amazon_order_id IS NULL;

-- F6: 3 ngày thủng phải CÓ trong MASTER (không chỉ staging)
SELECT report_date, COUNT(*) n FROM `afw_amazon_master.master_amazon_sales_traffic_by_asin`
WHERE report_date IN ('2026-04-16','2026-05-10','2026-07-02') GROUP BY 1 ORDER BY 1;

-- #9: open_date phải parse được 246/246 (trước đây NULL 100%)
SELECT COUNTIF(open_date IS NULL) null_open_date, COUNT(*) total
FROM `afw_amazon_master.master_amazon_listings` WHERE is_latest;

-- #8: đẳng thức inventory (kỳ vọng 0 lệch)
SELECT COUNTIF(total_quantity != fulfillable_quantity + inbound_working_quantity
  + inbound_shipped_quantity + inbound_receiving_quantity + reserved_quantity
  + unfulfillable_quantity + COALESCE(researching_quantity, 0)) AS n_lech
FROM `afw_amazon_master.master_amazon_inventory` WHERE is_latest;

-- Bug #1: đơn huỷ phải TĂNG so với 736 · Bug #3: FBA returns phải ra 191
SELECT order_status, COUNT(*) FROM `afw_amazon_master.master_amazon_orders` GROUP BY 1 ORDER BY 2 DESC;
SELECT COUNT(*) FROM `afw_amazon_staging.stg_amazon_fba_returns`;   -- 191, không phải 190
```

---

## 8. Còn treo

- 🟠 **`assert_no_date_gaps` chỉ đọc STAGING** → không bắt được lỗ hổng ở MASTER. Chính nó khiến F6 thủng âm thầm. Nên nhân bản sang master.
- 🟡 `stg_amazon_sales_traffic_*` dùng `CAST` thay `SAFE_CAST` (lệch quy ước với 10 staging còn lại).
- ⚠️ **VERIFY với Finance:** `mart_amazon_channel_pnl_monthly` dùng `posted_date` nguyên bản (góc nhìn **dòng tiền**). Muốn góc nhìn **accrual** phải map ngược kỳ — nhưng lệch kỳ **không đồng nhất** (ads gần real-time, storage trễ 1 tháng). **Đừng shift đồng loạt.**
- **Ad spend theo SKU** vẫn cần Advertising API — settlement chỉ có cấp tài khoản.
- **Cost Allocation Engine**: cước nhập ~$14K (`FBA International Freight` −$8,446 + `Duties and Taxes` −$5,747) giờ **đã có nguồn** trong `settlement_fees`.
- **Cập nhật docs**: `AFW_Amazon_Pipeline_Documentation.docx` + `Data_Dictionary.xlsx` vẫn **LỖI THỜI**.
