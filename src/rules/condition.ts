/**
 * ルールの条件。式を自由に書かせず、決まった部品の組み合わせ（すべて満たす）にする。
 * 連絡できるか（LINE・案内メールの同意）は Banto に聞かないと分からないので、送る直前に確かめる（src/runs/execute.ts）。
 */
export type PurchaseMode = "all_in_one_order" | "distinct_at_least" | "quantity_at_least";

export interface Condition {
  /** 商品の集まりを買った */
  purchase: { set_id: string; mode: PurchaseMode; n: number; days: number | null } | null;
  /** 注文の回数 */
  orders_at_least: { n: number; days: number | null } | null;
  /** 累計の購入額（値引き後・送料込みの注文の合計） */
  spend_at_least: { yen: number; days: number | null } | null;
}

export const MODES: { value: PurchaseMode; label: string }[] = [
  { value: "all_in_one_order", label: "1 回の注文で全部を買った" },
  { value: "distinct_at_least", label: "このうち n 種類以上を買ったことがある" },
  { value: "quantity_at_least", label: "このうち合計 n 点以上を買った" },
];

export const RULE_STATUSES = [
  { value: "draft", label: "下書き（動かさない）" },
  { value: "record_only", label: "記録だけ（当たった人を記録する。送らない）" },
  { value: "active", label: "動かす（アクションを行う）" },
  { value: "paused", label: "止めている" },
] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number]["value"];

export const isRuleStatus = (v: unknown): v is RuleStatus => RULE_STATUSES.some((s) => s.value === v);

/** 1 ショップで動かせる（記録だけ・動かす）ルールの数。注文 1 件で全部を確かめるので、D1 のクエリの数に収める */
export const MAX_RUNNING_RULES = 20;

export const EMPTY: Condition = { purchase: null, orders_at_least: null, spend_at_least: null };

const posInt = (v: unknown, max: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};
const days = (v: unknown): number | null | undefined => {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  return posInt(v, 3650) ?? undefined;
};

export type ParseResult = { ok: true; condition: Condition } | { ok: false; errors: string[] };

/** 画面のフォーム（文字の値）から組み立てる。誤りは画面に出す文で返す */
export function parseConditionForm(f: Record<string, string | undefined>, setIds: Set<string>, opts: { allowEmpty?: boolean } = {}): ParseResult {
  const errors: string[] = [];
  const c: Condition = { purchase: null, orders_at_least: null, spend_at_least: null };
  if (f["purchase_on"]) {
    const set_id = f["set_id"] ?? "";
    const mode = f["mode"] as PurchaseMode;
    const d = days(f["purchase_days"]);
    if (!setIds.has(set_id)) errors.push("商品の集まりを選んでください");
    if (!MODES.some((m) => m.value === mode)) errors.push("数え方を選んでください");
    const n = mode === "all_in_one_order" ? 1 : posInt(f["n"], 10000);
    if (n === null) errors.push("n には 1 以上の数を入れてください");
    if (d === undefined) errors.push("購入の期間は 1〜3650 日か、空（いつでも）にしてください");
    if (errors.length === 0) c.purchase = { set_id, mode, n: n ?? 1, days: d ?? null };
  }
  if (f["orders_on"]) {
    const n = posInt(f["orders_n"], 10000);
    const d = days(f["orders_days"]);
    if (n === null) errors.push("注文の回数には 1 以上の数を入れてください");
    if (d === undefined) errors.push("注文の回数の期間は 1〜3650 日か、空にしてください");
    if (n !== null && d !== undefined) c.orders_at_least = { n, days: d };
  }
  if (f["spend_on"]) {
    const yen = posInt(f["spend_yen"], 1_000_000_000);
    const d = days(f["spend_days"]);
    if (yen === null) errors.push("累計の購入額には 1 円以上を入れてください");
    if (d === undefined) errors.push("購入額の期間は 1〜3650 日か、空にしてください");
    if (yen !== null && d !== undefined) c.spend_at_least = { yen, days: d };
  }
  if (errors.length === 0 && !opts.allowEmpty && !c.purchase && !c.orders_at_least && !c.spend_at_least) errors.push("条件を 1 つ以上決めてください");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, condition: c };
}

/** 保存した JSON を読む（形が違えば空の条件） */
export function readCondition(json: string): Condition {
  try {
    const v = JSON.parse(json) as Partial<Condition>;
    return { purchase: v.purchase ?? null, orders_at_least: v.orders_at_least ?? null, spend_at_least: v.spend_at_least ?? null };
  } catch {
    return EMPTY;
  }
}

const period = (d: number | null) => (d ? `直近 ${d} 日に` : "これまでに");

/** 画面に出す説明 */
export function describe(c: Condition, setName: (id: string) => string): string[] {
  const out: string[] = [];
  if (c.purchase) {
    const s = `「${setName(c.purchase.set_id)}」`;
    const p = c.purchase;
    out.push(
      p.mode === "all_in_one_order"
        ? `${period(p.days)}${s}を 1 回の注文で全部買った`
        : p.mode === "distinct_at_least"
          ? `${period(p.days)}${s}のうち ${p.n} 種類以上を買った`
          : `${period(p.days)}${s}を合計 ${p.n} 点以上買った`,
    );
  }
  if (c.orders_at_least) out.push(`${period(c.orders_at_least.days)}${c.orders_at_least.n} 回以上注文した`);
  if (c.spend_at_least) out.push(`${period(c.spend_at_least.days)}合計 ${c.spend_at_least.yen.toLocaleString("ja-JP")} 円以上買った`);
  return out;
}

export const RUNNING_STATUSES: RuleStatus[] = ["record_only", "active"];
