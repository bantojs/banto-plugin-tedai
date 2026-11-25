/** 受け取った配信 ID（Banto は再送でも同じ ID で送る）。初めてなら true */
import { clearRevoked } from "./purge";
import type { SqlDb } from "./sql";

export async function recordDelivery(db: SqlDb, d: { id: string; shop_id: string; event: string }, now: number): Promise<boolean> {
  const [r] = await db.batch([
    { sql: `INSERT OR IGNORE INTO hook_deliveries (id, shop_id, event, received_at) VALUES (?, ?, ?, ?)`, params: [d.id, d.shop_id, d.event, now] },
    // 署名を確かめた hooks が届いた = Banto でつながっている（連携を外されたとみなさない。src/store/purge.ts）
    clearRevoked(d.shop_id),
  ]);
  return (r?.changes ?? 0) > 0;
}

/** 処理に失敗した配信を「受け取っていない」に戻す（Banto に再送してもらう） */
export async function forgetDelivery(db: SqlDb, shopId: string, id: string): Promise<void> {
  await db.run(`DELETE FROM hook_deliveries WHERE shop_id = ? AND id = ?`, [shopId, id]);
}

/** Banto の再送は 30 分ほどで終わるので、7 日より古いものは要らない */
export async function pruneDeliveries(db: SqlDb, now: number, keepSeconds = 7 * 86400): Promise<number> {
  return (await db.run(`DELETE FROM hook_deliveries WHERE received_at < ?`, [now - keepSeconds])).changes;
}
