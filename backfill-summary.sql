-- Dựng sẵn review_summary cho MỌI user có từ đã lưu (chạy một lần sau khi
-- migrate; idempotent — INSERT OR REPLACE nên chạy lại để "rebuild" cũng được).
-- Định nghĩa rated/ivl/due PHẢI khớp RATED_SQL / IVL_SQL / ratedDueBetween trong
-- toeic-with-james/src/lib/review.ts và backend/src/summary.ts.
-- Ngưỡng bucket: 1d=86400000, 3d=259200000, 8d=691200000, 16d=1382400000.
-- Chạy:
--   npx wrangler d1 execute james-db --remote --config wrangler.jsonc \
--     --file=../backend/backfill-summary.sql   (từ thư mục toeic-with-james)

INSERT OR REPLACE INTO review_summary
  (userId, total, unrated, b1, b2, b3, b4, b5, dueCnt, dueAt, rebuiltAt, updatedAt)
SELECT
  userId,
  COUNT(*) total,
  SUM(rated = 0) unrated,
  SUM(ivl < 86400000) b1,
  SUM(ivl >= 86400000 AND ivl < 259200000) b2,
  SUM(ivl >= 259200000 AND ivl < 691200000) b3,
  SUM(ivl >= 691200000 AND ivl < 1382400000) b4,
  SUM(ivl >= 1382400000) b5,
  SUM(isdue) dueCnt,
  CAST(strftime('%s','now') AS INTEGER) * 1000 dueAt,
  CAST(strftime('%s','now') AS INTEGER) * 1000 rebuiltAt,
  CAST(strftime('%s','now') AS INTEGER) * 1000 updatedAt
FROM (
  SELECT
    s.userId userId,
    CASE WHEN r.id IS NULL THEN 0
         WHEN (r.firstRatingAt IS NOT NULL
               OR r.last_review IS NOT NULL
               OR json_extract(r.data,'$.lastAt') IS NOT NULL
               OR json_extract(r.data,'$.fallbackState.lastAt') IS NOT NULL
               OR json_extract(r.data,'$.firstRatingAt') IS NOT NULL)
         THEN 1 ELSE 0 END rated,
    CASE WHEN r.id IS NULL THEN 0
         WHEN json_type(r.data,'$.stability') IN ('integer','real')
           THEN json_extract(r.data,'$.stability') * 86400000
         WHEN json_type(r.data,'$.ivl') IN ('integer','real')
           THEN json_extract(r.data,'$.ivl')
         ELSE 0 END ivl,
    CASE WHEN r.grp IN (1, 2) AND r.due > 0
              AND r.due <= CAST(strftime('%s','now') AS INTEGER) * 1000
         THEN 1 ELSE 0 END isdue
  FROM saved_words s
  LEFT JOIN review_stats r ON r.userId = s.userId AND r.wordId = s.wordId
)
GROUP BY userId;
