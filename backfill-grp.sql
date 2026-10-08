-- Backfill review_stats.grp (idempotent: chỉ row grp IS NULL).
--   wrangler d1 execute james-db --remote --file=backfill-grp.sql
-- "Đã rating" khớp getReviewStats (site): last_review || data.lastAt ||
-- data.fallbackState.lastAt || firstRatingAt — row legacy chỉ có lastAt
-- trong data JSON, cột last_review/firstRatingAt NULL.
UPDATE review_stats SET grp = CASE
  WHEN (firstRatingAt IS NOT NULL
        OR last_review IS NOT NULL
        OR json_extract(data, '$.lastAt') IS NOT NULL
        OR json_extract(data, '$.fallbackState.lastAt') IS NOT NULL
        OR json_extract(data, '$.firstRatingAt') IS NOT NULL)
  THEN CASE WHEN json_extract(data, '$.state') IN (1, 3) THEN 1 ELSE 2 END
  ELSE 0
END
WHERE grp IS NULL;
