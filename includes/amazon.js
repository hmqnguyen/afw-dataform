// Helper dùng chung cho Amazon SQLX (mirror includes/lecangs.js của AfwLecangsDataform).
// Amazon SP-API trả ISO 8601 chuẩn với offset dạng '+00:00' (có dấu hai chấm).
// PARSE_TIMESTAMP('%Ez') đòi '+0000' (không dấu hai chấm) → parse fail âm thầm,
// trả NULL cho toàn bộ cột. SAFE_CAST(... AS TIMESTAMP) nhận diện mọi biến thể
// ISO 8601 hợp lệ nên an toàn hơn.
function ts(expr) {
  return `SAFE_CAST(${expr} AS TIMESTAMP)`;
}

module.exports = { ts };
