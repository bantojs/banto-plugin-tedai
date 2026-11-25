/** 会員のお気に入り（会員 ID・商品 ID・足した時刻だけ） */
import type { SqlDb, SqlStatement } from "./sql";

export const favoriteInsert = (shopId: string, customerId: string, productId: string, addedAt: number): SqlStatement => ({
  // 同じ組がもうあれば何もしない（書き込みの行数を使わない）。退会した会員のものは戻さない
  sql: `INSERT OR IGNORE INTO favorites (shop_id, customer_id, product_id, added_at)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM forgotten_customers WHERE shop_id = ? AND customer_id = ?)`,
  params: [shopId, customerId, productId, addedAt, shopId, customerId],
});

export async function addFavorite(db: SqlDb, shopId: string, customerId: string, productId: string, addedAt: number): Promise<void> {
  const s = favoriteInsert(shopId, customerId, productId, addedAt);
  await db.run(s.sql, s.params);
}

export async function removeFavorite(db: SqlDb, shopId: string, customerId: string, productId: string): Promise<void> {
  await db.run(`DELETE FROM favorites WHERE shop_id = ? AND customer_id = ? AND product_id = ?`, [shopId, customerId, productId]);
}

export async function favoriteStats(db: SqlDb, shopId: string): Promise<{ favorites: number; customers: number }> {
  return (
    (await db.first<{ favorites: number; customers: number }>(
      `SELECT COUNT(*) AS favorites, COUNT(DISTINCT customer_id) AS customers FROM favorites WHERE shop_id = ?`,
      [shopId],
    )) ?? { favorites: 0, customers: 0 }
  );
}
