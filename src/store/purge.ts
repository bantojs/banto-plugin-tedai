/**
 * Banto で連携を外されたショップの、お客様に関わる記録を消す。
 * 手代には「外した」の知らせが来ない。Banto はトークンの失効のほか、スコープの不足・つないだ人の権限の喪失でも 401 を返すので、
 * 401 だけでは外されたと決めない。外すと Banto は送信先も消すので、hooks が届いているあいだはつながっているとみなす:
 * - 注文の突き合わせが 401 になり始めた時刻を覚える（つないだときに orders:read を許されていたショップだけ）
 * - 署名を確かめた hooks を受け取ったら・突き合わせが読めたら・つなぎ直したら、印を外す
 * - 印が付いたまま 30 日（= 30 日 hooks も来ず、突き合わせも断られ続けた）なら消す
 * ルール・文面・設定・接続・退会した会員の印は残す（つなぎ直せば、注文の写しは Banto から読み直す）
 */
import type { SqlDb } from "./sql";

/** 断られ続けてから消すまで */
export const PURGE_REVOKED_AFTER_SECONDS = 30 * 86400;

export const revokedKey = (shopId: string) => `revoked_since:${shopId}`;

/** トークンを断られた（初めてなら時刻を覚える）。1 回の batch に入れる文 */
export const markRevoked = (shopId: string, now: number) => ({ sql: `INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)`, params: [revokedKey(shopId), String(now)] });

/** 読めた・hooks が届いた・つなぎ直した */
export const clearRevoked = (shopId: string) => ({ sql: `DELETE FROM kv WHERE key = ?`, params: [revokedKey(shopId)] });

export async function revokedSince(db: SqlDb, shopId: string): Promise<number | null> {
  const v = (await db.first<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [revokedKey(shopId)]))?.value;
  return v === undefined ? null : Number(v);
}

const SHOP_TABLES = ["orders", "order_products", "favorites", "favorite_sync", "order_sync", "rule_hits", "runs", "rule_scans", "product_state", "notice_sends", "hook_deliveries"];

/** 1 回に 1 つの表から消す行の数（大きなショップでも 1 回の D1 の時間に収める） */
export const PURGE_CHUNK = 2000;

/**
 * 断られ続けたショップの記録を、1 回の Cron で表ごとに PURGE_CHUNK 行まで消す（D1 の問い合わせは 2〜3 回）。
 * 消し切ったら印を外す。消すのに失敗したショップは 1 日後ろへ回す（ほかのショップの消去を止めない）。
 * 消し切ったショップの ID を返す
 */
export async function purgeRevokedShop(db: SqlDb, now: number): Promise<string | null> {
  const r = await db.first<{ key: string; value: string }>(
    `SELECT key, value FROM kv WHERE key LIKE 'revoked_since:%' AND CAST(value AS INTEGER) < ? ORDER BY CAST(value AS INTEGER) LIMIT 1`,
    [now - PURGE_REVOKED_AFTER_SECONDS],
  );
  if (!r) return null;
  const shopId = r.key.slice("revoked_since:".length);
  let results: { changes: number }[];
  try {
    results = await db.batch([
      ...SHOP_TABLES.map((t) => ({ sql: `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE shop_id = ? LIMIT ${PURGE_CHUNK})`, params: [shopId] })),
      { sql: `DELETE FROM kv WHERE key = ?`, params: [`late_orders:${shopId}`] },
    ]);
  } catch (e) {
    await db.run(`UPDATE kv SET value = ? WHERE key = ? AND value = ?`, [String(Number(r.value) + 86400), r.key, r.value]);
    throw e;
  }
  if (results.slice(0, SHOP_TABLES.length).some((x) => x.changes >= PURGE_CHUNK)) return null;
  await db.run(clearRevoked(shopId).sql, clearRevoked(shopId).params);
  return shopId;
}
