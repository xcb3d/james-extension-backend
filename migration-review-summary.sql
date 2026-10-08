-- Migration giảm row-read của trang ôn tập + extension badge.
-- Chạy MỘT LẦN (ALTER không idempotent):
--   wrangler d1 execute james-db --remote --file=migration-review-summary.sql
-- Sau đó chạy backfill-grp.sql (idempotent — chạy lại sau mỗi lần deploy
-- site nếu cần, chỉ động tới row grp IS NULL).

-- grp: nhóm lập lịch của từ, để chọn từ đến hạn bằng index thay vì quét hết.
--   0 = chưa từng ôn, 1 = Learning/Relearning, 2 = Review (gồm legacy).
ALTER TABLE review_stats ADD COLUMN grp INTEGER;

-- Chọn/đếm từ đến hạn: userId + grp + due.
CREATE INDEX IF NOT EXISTS rs_user_grp_due ON review_stats(userId, grp, due);
-- newQuotaLeft: đếm từ mới rating hôm nay mà không quét cả bảng.
CREATE INDEX IF NOT EXISTS rs_user_first ON review_stats(userId, firstRatingAt);

-- 1 row/user: số liệu biểu đồ C1..C5 + snapshot số từ đến hạn.
--   dueCnt = số từ đã rating, còn trong sổ, 0 < due <= dueAt (chính xác tại dueAt).
--   Đọc: chỉ đếm khoảng (dueAt, now] rồi cộng dồn → không đếm lại toàn bộ.
--   nextDue KHÔNG lưu (tra bằng index rs_user_grp_due).
CREATE TABLE IF NOT EXISTS review_summary (
  userId TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  unrated INTEGER NOT NULL DEFAULT 0,
  b1 INTEGER NOT NULL DEFAULT 0,
  b2 INTEGER NOT NULL DEFAULT 0,
  b3 INTEGER NOT NULL DEFAULT 0,
  b4 INTEGER NOT NULL DEFAULT 0,
  b5 INTEGER NOT NULL DEFAULT 0,
  dueCnt INTEGER NOT NULL DEFAULT 0,
  dueAt INTEGER NOT NULL DEFAULT 0,
  rebuiltAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
