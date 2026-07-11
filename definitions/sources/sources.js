// sources.js
// Khai báo toàn bộ raw tables như external data sources.
// Raw tables do C# sync services ghi vào — Dataform chỉ đọc, không quản lý.
//
// LƯU Ý: raw_amazon_ads_performance KHÔNG còn ở đây — Ads đã tách hoàn
// toàn sang project riêng (AfwAdsSync C# + AfwAdsDataform), xem
// definitions/sources/sources.js của repo đó.
//
// Dùng dataform.projectConfig.vars.raw_dataset để lấy tên dataset
// tương ứng với môi trường (dev/prod) từ environments/*.json.
// Nếu vars chưa set, fallback về "afw_amazon_raw".

const rawDataset = dataform.projectConfig.vars && dataform.projectConfig.vars.raw_dataset
  ? dataform.projectConfig.vars.raw_dataset
  : "afw_amazon_raw";

const rawTables = [
  "raw_amazon_order_report",
  "raw_amazon_inventory",
  "raw_amazon_settlement",
  "raw_amazon_returns",
  "raw_amazon_fba_returns",
  "raw_amazon_asin_review_topics",
  "raw_amazon_asin_review_trends",
  "raw_amazon_browse_node_review_topics",
  "raw_amazon_browse_node_return_topics",
  "raw_amazon_browse_node_return_trends",
  "raw_amazon_storage_fees",
  "raw_amazon_inventory_planning",
  "raw_amazon_inventory_ledger",
  "raw_amazon_listings",
  "raw_amazon_sales_traffic_by_date",
  "raw_amazon_sales_traffic_by_asin",
];

rawTables.forEach(tableName => {
  declare({
    database: dataform.projectConfig.defaultDatabase,
    schema: rawDataset,
    name: tableName,
  });
});
