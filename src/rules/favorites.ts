/**
 * お気に入りのきっかけ（再入荷・値下げ・残りわずか）。
 * - お気に入りに入っている商品だけ、前に見た在庫の合計と最安値を product_state に覚える（ID・数だけ）
 * - Banto の product.updated で商品を読み直して比べる。覚えていない商品は Cron で少しずつ読んでおく（覚える前の変化には当てない）
 * - 残りわずかは Banto の inventory.low（在庫がまだある分だけ）
 * - 当てるのは、その商品をお気に入りに入れている会員 × 商品で 1 回。「その商品をもう買った会員は除く」を選べる
 */
import { productSnapshot } from "../banto/catalog";
import type { Deps } from "../deps";
import type { Connection } from "../store/connections";
import { ConnectionRepo } from "../store/connections";
import { listRules, type Rule } from "../store/rules";
import type { SqlDb, SqlStatement, SqlValue } from "../store/sql";
import { MAX_RUNNING_RULES, RUNNING_STATUSES } from "./condition";
import { hasParts, matchSql } from "./evaluate";
import { hitStatements } from "./trigger";
import { FAVORITE_KINDS, type TriggerKind } from "./triggers";
import { groupsOf, variantKey, variantOf, type SkuMap, type Variant } from "./variants";
import { setKv } from "../store/settings";

/** 1 回の出来事で当てる会員の上限（多い商品は、ルールの上限・お客様ごとの上限とあわせて抑える） */
export const FAN_OUT_LIMIT = 500;

export async function favoriteRules(db: SqlDb, shopId: string, kinds: TriggerKind[] = FAVORITE_KINDS): Promise<Rule[]> {
  return (await listRules(db, shopId, RUNNING_STATUSES)).filter((r) => kinds.includes(r.trigger.kind)).slice(0, MAX_RUNNING_RULES);
}

const isFavorited = async (db: SqlDb, shopId: string, productId: string) =>
  !!(await db.first<{ x: number }>(`SELECT 1 AS x FROM favorites WHERE shop_id = ? AND product_id = ? LIMIT 1`, [shopId, productId]));

/** その商品をお気に入りに入れている会員にルールを当てる（variant があれば、そのオプションのまとまりとして。会員 × 商品 × まとまりで 1 回） */
export async function fanOut(db: SqlDb, rule: Rule, shopId: string, productId: string, now: number, variant: Variant | null = null): Promise<number> {
  const cond = hasParts(rule.condition) ? matchSql(rule.condition, { shopId, now }) : null;
  const params: SqlValue[] = [shopId, productId];
  let sql = `SELECT f.customer_id FROM favorites f WHERE f.shop_id = ? AND f.product_id = ?`;
  if (rule.trigger.excludeBought !== false) {
    sql += ` AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_products op ON op.shop_id = o.shop_id AND op.order_id = o.order_id
              WHERE o.shop_id = ? AND o.customer_id = f.customer_id AND o.cancelled = 0 AND op.product_id = ?)`;
    params.push(shopId, productId);
  }
  if (cond) {
    sql += ` AND f.customer_id IN (${cond.sql})`;
    params.push(...cond.params);
  }
  sql += ` ORDER BY f.added_at LIMIT ?`;
  params.push(FAN_OUT_LIMIT);
  const rows = await db.all<{ customer_id: string }>(sql, params);
  const statements: SqlStatement[] = [];
  const vk = variant && Object.keys(variant).length > 0 ? `:${variantKey(variant)}` : "";
  for (const r of rows)
    statements.push(...(await hitStatements(rule, shopId, { customerId: r.customer_id, orderId: null, productId, hitKey: `${r.customer_id}:${productId}${vk}`, variant }, now)));
  if (statements.length > 0) await db.batch(statements);
  return rows.length;
}

/** product.updated: 在庫と値段を読み直して、ルールの見る単位（商品・オプション・SKU）ごとに再入荷・値下げなら当てる */
export async function onProductUpdated(deps: Deps, conn: Connection, productId: string): Promise<void> {
  const db = deps.db;
  const shopId = conn.shop_id;
  const rules = await favoriteRules(db, shopId, ["favorite_restock", "favorite_price_drop"]);
  if (rules.length === 0 || !(await isFavorited(db, shopId, productId))) return;
  const token = await new ConnectionRepo(db, deps.config.secret).token(shopId);
  if (!token) throw new Error("token_unavailable");
  const snap = await productSnapshot(deps, token, productId);
  if (!snap) return;
  const prev = await db.first<{ available: number; min_price: number | null; skus: string | null }>(
    `SELECT available, min_price, skus FROM product_state WHERE shop_id = ? AND product_id = ?`,
    [shopId, productId],
  );
  const now = deps.now();
  await saveState(db, shopId, productId, snap.available, snap.min_price, snap.skus, now);
  await rememberOptionNames(db, shopId, snap.option_names);
  if (!prev || !snap.published) return;
  const prevSkus = readSkus(prev.skus);
  for (const r of rules) {
    if (!r.trigger.unit || r.trigger.unit === "product") {
      const restocked = prev.available <= 0 && snap.available > 0;
      const dropped = prev.min_price !== null && snap.min_price !== null && snap.min_price < prev.min_price;
      if ((r.trigger.kind === "favorite_restock" && restocked) || (r.trigger.kind === "favorite_price_drop" && dropped)) await fanOut(db, r, shopId, productId, now);
      continue;
    }
    // オプションのまとまりごと（前に SKU ごとを覚えていなければ、今回は覚えるだけ）
    if (!prevSkus) continue;
    const before = groupsOf(prevSkus, r.trigger);
    for (const [key, g] of groupsOf(snap.skus, r.trigger)) {
      const b = before.get(key);
      if (!b) continue; // 新しく足した SKU は再入荷ではない
      const restocked = b.available <= 0 && g.available > 0;
      const dropped = b.minPrice !== null && g.minPrice !== null && g.minPrice < b.minPrice;
      if ((r.trigger.kind === "favorite_restock" && restocked) || (r.trigger.kind === "favorite_price_drop" && dropped)) await fanOut(db, r, shopId, productId, now, g.variant);
    }
  }
}

/** inventory.low: まだ在庫があれば、残りわずかのルールを当てる（オプションごと・SKU ごとのルールは、知らせの SKU が入るまとまりで） */
export async function onInventoryLow(deps: Deps, conn: Connection, productId: string, available: number, skuId: string | null = null): Promise<void> {
  if (available <= 0) return;
  const rules = await favoriteRules(deps.db, conn.shop_id, ["favorite_low_stock"]);
  if (rules.length === 0) return;
  let skus: SkuMap | null = null;
  for (const r of rules) {
    if (!r.trigger.unit || r.trigger.unit === "product" || !skuId) {
      await fanOut(deps.db, r, conn.shop_id, productId, deps.now());
      continue;
    }
    if (!skus) {
      const token = await new ConnectionRepo(deps.db, deps.config.secret).token(conn.shop_id);
      const snap = token ? await productSnapshot(deps, token, productId) : null;
      if (!snap) return;
      skus = snap.skus;
      await rememberOptionNames(deps.db, conn.shop_id, snap.option_names);
    }
    const sku = skus[skuId];
    if (!sku) continue;
    const v = variantOf(sku.o, r.trigger);
    const g = groupsOf(skus, r.trigger).get(variantKey(v));
    if (g && g.available > 0) await fanOut(deps.db, r, conn.shop_id, productId, deps.now(), v);
  }
}

function readSkus(json: string | null): SkuMap | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as SkuMap;
  } catch {
    return null;
  }
}

const saveState = (db: SqlDb, shopId: string, productId: string, available: number, minPrice: number | null, skus: SkuMap | null, now: number) =>
  db.run(
    `INSERT INTO product_state (shop_id, product_id, available, min_price, skus, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_id, product_id) DO UPDATE SET available = excluded.available, min_price = excluded.min_price, skus = excluded.skus, updated_at = excluded.updated_at`,
    [shopId, productId, available, minPrice, skus ? JSON.stringify(skus) : null, now],
  );

/** ショップのオプションの名前の表を覚える（ルールの画面の「オプションを選ぶ」と {{variant}} に使う） */
export const optionNamesKey = (shopId: string) => `option_names:${shopId}`;
const rememberOptionNames = async (db: SqlDb, shopId: string, names: Record<string, string>) => {
  if (Object.keys(names).length > 0) await setKv(db, optionNamesKey(shopId), JSON.stringify(names));
};

/** Cron: お気に入りに入っていて、まだ覚えていない商品（SKU ごとをまだ覚えていない商品も）を budget 個まで読んでおく（再入荷・値下げのルールがあるときだけ） */
export async function backfillProductStates(deps: Deps, conn: Connection, budget: number, canContinue: () => boolean = () => true): Promise<number> {
  const db = deps.db;
  if ((await favoriteRules(db, conn.shop_id, ["favorite_restock", "favorite_price_drop"])).length === 0) return 0;
  const rows = await db.all<{ product_id: string }>(
    `SELECT DISTINCT f.product_id FROM favorites f LEFT JOIN product_state p ON p.shop_id = f.shop_id AND p.product_id = f.product_id
     WHERE f.shop_id = ? AND (p.product_id IS NULL OR p.skus IS NULL) LIMIT ?`,
    [conn.shop_id, budget],
  );
  if (rows.length === 0) return 0;
  const token = await new ConnectionRepo(db, deps.config.secret).token(conn.shop_id);
  if (!token) return 0;
  for (const r of rows) {
    // Cron の上限に収まるか（src/budget.ts）
    if (!canContinue()) break;
    const snap = await productSnapshot(deps, token, r.product_id);
    // 消えた商品は「在庫 0・値段なし」で覚え、何度も読みに行かない
    await saveState(db, conn.shop_id, r.product_id, snap?.available ?? 0, snap?.min_price ?? null, snap?.skus ?? null, deps.now());
    if (snap) await rememberOptionNames(db, conn.shop_id, snap.option_names);
  }
  return rows.length;
}

/** 試しに当てる（お気に入りのきっかけ）: お気に入りに商品を入れている会員（条件があれば満たす人） */
export async function previewFavorites(db: SqlDb, c: import("./condition").Condition, shopId: string, now: number): Promise<{ count: number; sample: string[] }> {
  const cond = hasParts(c) ? matchSql(c, { shopId, now }) : null;
  const where = `WHERE shop_id = ?${cond ? ` AND customer_id IN (${cond.sql})` : ""}`;
  const params: SqlValue[] = [shopId, ...(cond ? cond.params : [])];
  const n = await db.first<{ n: number }>(`SELECT COUNT(DISTINCT customer_id) AS n FROM favorites ${where}`, params);
  const sample = await db.all<{ customer_id: string }>(`SELECT customer_id FROM favorites ${where} GROUP BY customer_id ORDER BY MAX(added_at) DESC LIMIT 10`, params);
  return { count: n?.n ?? 0, sample: sample.map((x) => x.customer_id) };
}
