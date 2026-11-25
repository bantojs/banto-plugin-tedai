/** 商品の集まりとルールの読み書き */
import { readActions, type Actions } from "../rules/actions";
import { readCondition, type Condition, type RuleStatus } from "../rules/condition";
import { readTrigger, triggerOpts, type Trigger } from "../rules/triggers";
import type { SqlDb } from "./sql";

export const MAX_SET_ITEMS = 200;
export const MAX_SETS = 50;
export const MAX_RULES = 100;

export interface ProductSet {
  id: string;
  name: string;
  count: number;
  updated_at: number;
}

export interface SetItem {
  product_id: string;
  product_name: string;
  product_slug: string;
}

export interface Rule {
  id: string;
  name: string;
  status: RuleStatus;
  trigger: Trigger;
  condition: Condition;
  actions: Actions;
  created_at: number;
  updated_at: number;
}

export async function listSets(db: SqlDb, shopId: string): Promise<ProductSet[]> {
  return db.all<ProductSet>(
    `SELECT s.id, s.name, s.updated_at, (SELECT COUNT(*) FROM product_set_items i WHERE i.shop_id = s.shop_id AND i.set_id = s.id) AS count
     FROM product_sets s WHERE s.shop_id = ? ORDER BY s.name`,
    [shopId],
  );
}

export async function getSet(db: SqlDb, shopId: string, id: string): Promise<{ set: ProductSet; items: SetItem[] } | null> {
  const set = (await listSets(db, shopId)).find((s) => s.id === id);
  if (!set) return null;
  const items = await db.all<SetItem>(`SELECT product_id, product_name, product_slug FROM product_set_items WHERE shop_id = ? AND set_id = ? ORDER BY product_name`, [shopId, id]);
  return { set, items };
}

export async function createSet(db: SqlDb, shopId: string, name: string, now: number): Promise<string | "too_many"> {
  const n = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM product_sets WHERE shop_id = ?`, [shopId]))?.n ?? 0;
  if (n >= MAX_SETS) return "too_many";
  const id = crypto.randomUUID();
  await db.run(`INSERT INTO product_sets (shop_id, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [shopId, id, name, now, now]);
  return id;
}

export async function renameSet(db: SqlDb, shopId: string, id: string, name: string, now: number): Promise<void> {
  await db.run(`UPDATE product_sets SET name = ?, updated_at = ? WHERE shop_id = ? AND id = ?`, [name, now, shopId, id]);
}

/** 足す（上限を超える分は足さない）。足した数を返す */
export async function addSetItems(db: SqlDb, shopId: string, setId: string, items: SetItem[], now: number): Promise<number> {
  const have = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM product_set_items WHERE shop_id = ? AND set_id = ?`, [shopId, setId]))?.n ?? 0;
  const room = Math.max(0, MAX_SET_ITEMS - have);
  const add = items.slice(0, room);
  if (add.length === 0) return 0;
  const r = await db.batch([
    ...add.map((i) => ({
      sql: `INSERT INTO product_set_items (shop_id, set_id, product_id, product_name, product_slug) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(shop_id, set_id, product_id) DO UPDATE SET product_name = excluded.product_name, product_slug = excluded.product_slug`,
      params: [shopId, setId, i.product_id, i.product_name.slice(0, 200), i.product_slug.slice(0, 200)],
    })),
    { sql: `UPDATE product_sets SET updated_at = ? WHERE shop_id = ? AND id = ?`, params: [now, shopId, setId] },
  ]);
  return r.slice(0, -1).reduce((a, x) => a + x.changes, 0);
}

export async function removeSetItems(db: SqlDb, shopId: string, setId: string, productIds: string[], now: number): Promise<void> {
  if (productIds.length === 0) return;
  await db.batch([
    ...productIds.map((p) => ({ sql: `DELETE FROM product_set_items WHERE shop_id = ? AND set_id = ? AND product_id = ?`, params: [shopId, setId, p] })),
    { sql: `UPDATE product_sets SET updated_at = ? WHERE shop_id = ? AND id = ?`, params: [now, shopId, setId] },
  ]);
}

/** ルールで使っている集まりは消さない */
export async function deleteSet(db: SqlDb, shopId: string, id: string): Promise<"ok" | "in_use"> {
  const rules = await listRules(db, shopId);
  if (rules.some((r) => r.condition.purchase?.set_id === id)) return "in_use";
  await db.batch([
    { sql: `DELETE FROM product_set_items WHERE shop_id = ? AND set_id = ?`, params: [shopId, id] },
    { sql: `DELETE FROM product_sets WHERE shop_id = ? AND id = ?`, params: [shopId, id] },
  ]);
  return "ok";
}

interface RuleRow {
  id: string;
  name: string;
  status: RuleStatus;
  trigger: string;
  trigger_days: number | null;
  trigger_opts: string | null;
  condition: string;
  actions: string;
  created_at: number;
  updated_at: number;
}

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  name: r.name,
  status: r.status,
  trigger: readTrigger(r.trigger, r.trigger_days, r.trigger_opts),
  condition: readCondition(r.condition),
  actions: readActions(r.actions),
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export async function listRules(db: SqlDb, shopId: string, statuses?: RuleStatus[]): Promise<Rule[]> {
  const rows = await db.all<RuleRow>(
    `SELECT id, name, status, trigger, trigger_days, trigger_opts, condition, actions, created_at, updated_at FROM rules WHERE shop_id = ?
     ${statuses ? `AND status IN (${statuses.map(() => "?").join(",")})` : ""} ORDER BY created_at`,
    [shopId, ...(statuses ?? [])],
  );
  return rows.map(toRule);
}

export async function getRule(db: SqlDb, shopId: string, id: string): Promise<Rule | null> {
  const r = await db.first<RuleRow>(`SELECT id, name, status, trigger, trigger_days, trigger_opts, condition, actions, created_at, updated_at FROM rules WHERE shop_id = ? AND id = ?`, [shopId, id]);
  return r ? toRule(r) : null;
}

export async function saveRule(
  db: SqlDb,
  shopId: string,
  r: { id: string | null; name: string; status: RuleStatus; condition: Condition; actions?: Actions; trigger?: Trigger },
  now: number,
): Promise<string | "too_many"> {
  const actions = JSON.stringify(r.actions ?? {});
  const trigger = r.trigger ?? { kind: "order.paid", days: null };
  if (r.id) {
    // きっかけを変えたら、時刻のきっかけの見た位置を作り直す（新しいきっかけは、変えたときから当てる）
    const before = await db.first<{ trigger: string; trigger_days: number | null; status: string }>(`SELECT trigger, trigger_days, status FROM rules WHERE shop_id = ? AND id = ?`, [shopId, r.id]);
    const changed = !before || before.trigger !== trigger.kind || before.trigger_days !== trigger.days || before.status !== r.status;
    await db.batch([
      {
        sql: `UPDATE rules SET name = ?, status = ?, trigger = ?, trigger_days = ?, trigger_opts = ?, condition = ?, actions = ?, updated_at = ? WHERE shop_id = ? AND id = ?`,
        params: [r.name, r.status, trigger.kind, trigger.days, triggerOpts(trigger), JSON.stringify(r.condition), actions, now, shopId, r.id],
      },
      ...(changed ? [{ sql: `DELETE FROM rule_scans WHERE shop_id = ? AND rule_id = ?`, params: [shopId, r.id] }] : []),
    ]);
    return r.id;
  }
  const n = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rules WHERE shop_id = ?`, [shopId]))?.n ?? 0;
  if (n >= MAX_RULES) return "too_many";
  const id = crypto.randomUUID();
  await db.run(`INSERT INTO rules (shop_id, id, name, status, trigger, trigger_days, trigger_opts, condition, actions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    shopId,
    id,
    r.name,
    r.status,
    trigger.kind,
    trigger.days,
    triggerOpts(trigger),
    JSON.stringify(r.condition),
    actions,
    now,
    now,
  ]);
  return id;
}

export async function deleteRule(db: SqlDb, shopId: string, id: string): Promise<void> {
  await db.batch([
    { sql: `DELETE FROM runs WHERE shop_id = ? AND rule_id = ?`, params: [shopId, id] },
    { sql: `DELETE FROM rule_scans WHERE shop_id = ? AND rule_id = ?`, params: [shopId, id] },
    { sql: `DELETE FROM rule_hits WHERE shop_id = ? AND rule_id = ?`, params: [shopId, id] },
    { sql: `DELETE FROM rules WHERE shop_id = ? AND id = ?`, params: [shopId, id] },
  ]);
}

export interface Hit {
  customer_id: string;
  order_id: string | null;
  hit_at: number;
}

export async function listHits(db: SqlDb, shopId: string, ruleId: string, limit = 100): Promise<{ total: number; items: Hit[] }> {
  const total = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits WHERE shop_id = ? AND rule_id = ?`, [shopId, ruleId]))?.n ?? 0;
  const items = await db.all<Hit>(`SELECT customer_id, order_id, hit_at FROM rule_hits WHERE shop_id = ? AND rule_id = ? ORDER BY hit_at DESC LIMIT ?`, [shopId, ruleId, limit]);
  return { total, items };
}
