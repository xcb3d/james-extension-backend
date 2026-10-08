// review_summary — số liệu biểu đồ C1..C5 của trang ôn tập (1 row/user) và
// nguồn cho badge extension. BẢN SAO logic của toeic-with-james/src/lib/
// review.ts (getSummary/rebuildSummary): hai Worker chia sẻ chung D1 nên
// định nghĩa "rated"/ivl/bucket PHẢI giữ khớp nhau — sửa một nơi thì sửa cả
// hai. Row lệch được tự sửa bằng rebuild (thiếu row hoặc quá SUMMARY_TTL).
//
// Backend chỉ chạm vào summary ở 2 chỗ: lưu/gỡ từ (±1 vào bucket hiện tại
// của từ) và import hàng loạt (xoá row → rebuild lười). Chấm bài do site
// cập nhật (fsrsGrade).

const DAY_MS = 86_400_000;
const SUMMARY_TTL = 7 * DAY_MS;
const [L2, L3, L4, L5] = [1, 3, 8, 16].map((d) => d * DAY_MS);

/** Cấp hiển thị 1..5 theo ivl — khớp displayLevel() của site. */
const levelOf = (ivl: number) =>
  ivl < L2 ? 1 : ivl < L3 ? 2 : ivl < L4 ? 3 : ivl < L5 ? 4 : 5;

/** "Đã rating": row legacy chỉ có lastAt trong data JSON (cột NULL). */
const RATED_SQL = `(r.firstRatingAt IS NOT NULL
  OR r.last_review IS NOT NULL
  OR json_extract(r.data,'$.lastAt') IS NOT NULL
  OR json_extract(r.data,'$.fallbackState.lastAt') IS NOT NULL
  OR json_extract(r.data,'$.firstRatingAt') IS NOT NULL)`;
/** ivl (ms): FSRS stability (ngày) hoặc legacy ivl. */
const IVL_SQL = `CASE
  WHEN json_type(r.data,'$.stability') IN ('integer','real')
    THEN json_extract(r.data,'$.stability') * ${DAY_MS}
  WHEN json_type(r.data,'$.ivl') IN ('integer','real')
    THEN json_extract(r.data,'$.ivl')
  ELSE 0 END`;
/** Từ còn trong sổ — review_stats giữ cả row của từ đã gỡ. */
const SAVED_SQL = `EXISTS (SELECT 1 FROM saved_words s
  WHERE s.userId = r.userId AND s.wordId = r.wordId)`;

type SummaryRow = {
  total: number;
  unrated: number;
  b: number[];
  /** Số từ rated, còn trong sổ, 0 < due ≤ dueAt — chính xác tại dueAt. */
  dueCnt: number;
  dueAt: number;
};

async function rebuild(
  DB: D1Database,
  userId: string,
  now: number
): Promise<SummaryRow> {
  const r: any = await DB.prepare(
    `SELECT COUNT(*) total,
       COALESCE(SUM(rated = 0), 0) unrated,
       COALESCE(SUM(ivl < ${L2}), 0) b1,
       COALESCE(SUM(ivl >= ${L2} AND ivl < ${L3}), 0) b2,
       COALESCE(SUM(ivl >= ${L3} AND ivl < ${L4}), 0) b3,
       COALESCE(SUM(ivl >= ${L4} AND ivl < ${L5}), 0) b4,
       COALESCE(SUM(ivl >= ${L5}), 0) b5
     FROM (
       SELECT
         CASE WHEN r.id IS NULL THEN 0 WHEN ${RATED_SQL} THEN 1 ELSE 0 END rated,
         CASE WHEN r.id IS NULL THEN 0 ELSE ${IVL_SQL} END ivl
       FROM saved_words s
       LEFT JOIN review_stats r ON r.userId = s.userId AND r.wordId = s.wordId
       WHERE s.userId = ?
     )`
  )
    .bind(userId)
    .first();
  const row: SummaryRow = {
    total: Number(r?.total ?? 0),
    unrated: Number(r?.unrated ?? 0),
    b: [r?.b1, r?.b2, r?.b3, r?.b4, r?.b5].map((v) => Number(v ?? 0)),
    dueCnt: await ratedDueBetween(DB, userId, 0, now),
    dueAt: now,
  };
  await DB.prepare(
    `INSERT OR REPLACE INTO review_summary
       (userId, total, unrated, b1, b2, b3, b4, b5, dueCnt, dueAt, rebuiltAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, row.total, row.unrated, ...row.b, row.dueCnt, row.dueAt, now, now)
    .run();
  return row;
}

/** Đọc summary; thiếu/quá hạn → rebuild từ saved_words ⋈ review_stats. */
export async function getSummaryRow(
  DB: D1Database,
  userId: string,
  now: number
): Promise<SummaryRow> {
  const r: any = await DB.prepare(
    "SELECT * FROM review_summary WHERE userId = ?"
  )
    .bind(userId)
    .first();
  if (!r || now - Number(r.rebuiltAt) > SUMMARY_TTL)
    return rebuild(DB, userId, now);
  return {
    total: Number(r.total),
    unrated: Number(r.unrated),
    b: [r.b1, r.b2, r.b3, r.b4, r.b5].map(Number),
    dueCnt: Number(r.dueCnt),
    dueAt: Number(r.dueAt),
  };
}

/** Số từ rated, còn trong sổ, với from < due ≤ to (from=0 → mọi due>0).
 * Đọc theo số từ rơi vào khoảng này, không phải toàn sổ. */
async function ratedDueBetween(
  DB: D1Database,
  userId: string,
  from: number,
  to: number
): Promise<number> {
  const r: any = await DB.prepare(
    `SELECT COUNT(*) n FROM review_stats r
     WHERE r.userId = ? AND r.grp IN (1, 2) AND r.due > ? AND r.due <= ?
       AND ${SAVED_SQL}`
  )
    .bind(userId, from, to)
    .first();
  return Number(r?.n ?? 0);
}

/** Từ rated đến hạn (0 < due ≤ now) từ snapshot: chỉ đếm khoảng
 * (dueAt, now] rồi ghi lại tương đối + CAS theo dueAt (đọc song song không
 * cộng đôi, fsrsGrade/adjustForWord trừ xen vào không bị ghi đè). */
export async function ratedDueCount(
  DB: D1Database,
  userId: string,
  sum: SummaryRow,
  now: number
): Promise<number> {
  if (now <= sum.dueAt) return sum.dueCnt;
  const delta = await ratedDueBetween(DB, userId, sum.dueAt, now);
  if (delta > 0) {
    await DB.prepare(
      `UPDATE review_summary SET dueCnt = dueCnt + ?, dueAt = ?
       WHERE userId = ? AND dueAt = ?`
    )
      .bind(delta, now, userId, sum.dueAt)
      .run();
  }
  return sum.dueCnt + delta;
}

/** Mốc due kế tiếp (> now) — mỗi grp một LIMIT 1 theo index, không sort. */
export async function nextDueAt(
  DB: D1Database,
  userId: string,
  now: number
): Promise<number | null> {
  const one = (grp: number) =>
    `SELECT * FROM (SELECT r.due d FROM review_stats r
       WHERE r.userId = ? AND r.grp = ${grp} AND r.due > ? AND ${SAVED_SQL}
       ORDER BY r.due LIMIT 1)`;
  const r: any = await DB.prepare(
    `SELECT MIN(d) d FROM (${one(1)} UNION ALL ${one(2)})`
  )
    .bind(userId, now, userId, now)
    .first();
  return typeof r?.d === "number" ? r.d : null;
}

/** Từ vừa được lưu (sign=+1) / gỡ (sign=-1): cộng/trừ vào bucket hiện tại
 * của từ. Gỡ KHÔNG xoá review_stats nên stat của từ vẫn đọc được. No-op
 * nếu user chưa có row summary (lần đọc đầu sẽ rebuild đúng). */
export async function adjustForWord(
  DB: D1Database,
  userId: string,
  wordId: string,
  sign: 1 | -1
): Promise<void> {
  const s: any = await DB.prepare(
    `SELECT CASE WHEN ${RATED_SQL} THEN 1 ELSE 0 END rated, ${IVL_SQL} ivl,
       r.grp grp, r.due due
     FROM review_stats r WHERE r.userId = ? AND r.wordId = ?`
  )
    .bind(userId, wordId)
    .first();
  // Chưa có stat → từ mới: C1, chưa ôn.
  const rated = s ? Number(s.rated) === 1 : false;
  const lvl = levelOf(Number(s?.ivl ?? 0));
  const b = [0, 0, 0, 0, 0];
  b[lvl - 1] = sign;
  // Từ rated có due nằm trong snapshot (0 < due ≤ dueAt) → dueCnt cũng ±1.
  // Điều kiện grp/due khớp ratedDueBetween.
  const grp = Number(s?.grp ?? 0);
  const due = Number(s?.due ?? 0);
  const inGrp = grp === 1 || grp === 2;
  await DB.prepare(
    `UPDATE review_summary SET total = total + ?, unrated = unrated + ?,
       b1 = b1 + ?, b2 = b2 + ?, b3 = b3 + ?, b4 = b4 + ?, b5 = b5 + ?,
       dueCnt = dueCnt + CASE WHEN ? = 1 AND ? > 0 AND ? <= dueAt THEN ? ELSE 0 END,
       updatedAt = ?
     WHERE userId = ?`
  )
    .bind(
      sign,
      rated ? 0 : sign,
      ...b,
      inGrp ? 1 : 0,
      due,
      due,
      sign,
      Date.now(),
      userId
    )
    .run();
}

/** Import hàng loạt / thay đổi khó tính delta: xoá để rebuild lười. */
export async function invalidateSummary(
  DB: D1Database,
  userId: string
): Promise<void> {
  await DB.prepare("DELETE FROM review_summary WHERE userId = ?")
    .bind(userId)
    .run();
}
