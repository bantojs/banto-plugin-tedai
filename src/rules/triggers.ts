/**
 * ルールのきっかけ。決まった種類だけ。
 * - order.paid: 会員の注文が支払われた（その注文で条件に入ったときだけ当たる）
 * - last_order: 最後の購入から n 日たった（そのあいだ買っていない）。休眠のお客様への声かけ
 * - first_order: 初めての購入から n 日たった。初回のフォロー
 * - favorite_restock / favorite_price_drop / favorite_low_stock: お気に入りの商品の再入荷・値下げ・残りわずか（src/rules/favorites.ts）。
 *   会員 × 商品で 1 回
 * - checkout_abandoned: カゴ落ち（Banto の checkout.abandoned。会員だけ）。会員 × カゴで 1 回、1 時間以上待ってから、そのあと買っていなければ行う
 * 時刻のきっかけは 5 分ごとに「前に見たときから今までに、ちょうど n 日を過ぎた会員」を探す（src/rules/time-scan.ts）。
 * 動かし始める前に過ぎていた会員には当てない。
 */
export type TriggerKind = "order.paid" | "last_order" | "first_order" | "favorite_restock" | "favorite_price_drop" | "favorite_low_stock" | "checkout_abandoned";

export interface Trigger {
  kind: TriggerKind;
  /** last_order・first_order の日数 */
  days: number | null;
  /** お気に入りのきっかけ: その商品をもう買った会員は除く */
  excludeBought?: boolean;
  /**
   * お気に入りのきっかけで見る単位（Banto の SKU のオプションと同じ考え方）。
   * product = 商品の合計、axes = 選んだオプション（例 color）の値ごと、sku = 全部のオプションの組み合わせ（SKU 1 つ）
   */
  unit?: VariantUnit;
  axes?: string[];
}

export type VariantUnit = "product" | "axes" | "sku";
const AXIS_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const TRIGGERS: { value: TriggerKind; label: string; days?: boolean }[] = [
  { value: "order.paid", label: "会員の注文が支払われたとき" },
  { value: "last_order", label: "最後の購入から n 日たったとき（そのあいだ買っていない）", days: true },
  { value: "first_order", label: "初めての購入から n 日たったとき", days: true },
  { value: "favorite_restock", label: "お気に入りの商品が再入荷したとき（見る単位の在庫がゼロからありに）" },
  { value: "favorite_price_drop", label: "お気に入りの商品が値下げしたとき（見る単位のいちばん安い SKU の値段が下がった）" },
  { value: "favorite_low_stock", label: "お気に入りの商品が残りわずかになったとき（Banto の在庫僅少の知らせ）" },
  { value: "checkout_abandoned", label: "カゴ落ちしたとき（会員がレジまで進み、払わずに期限が切れた）" },
];

/** {{product_name}}・{{product_url}} が使えるきっかけ（お気に入りの商品・カゴの最初の商品） */
export const hasProduct = (k: TriggerKind) => isFavoriteTrigger(k) || k === "checkout_abandoned";
/** カゴ落ちは、期限切れのあとに決済が済むことがあるので、少なくともこれだけ待ってから「そのあと買ったか」を確かめて行う */
export const ABANDONED_MIN_DELAY = 3600;

export const isTimeTrigger = (k: TriggerKind) => k === "last_order" || k === "first_order";
export const isFavoriteTrigger = (k: TriggerKind) => k === "favorite_restock" || k === "favorite_price_drop" || k === "favorite_low_stock";
export const FAVORITE_KINDS: TriggerKind[] = ["favorite_restock", "favorite_price_drop", "favorite_low_stock"];

export const MAX_TRIGGER_DAYS = 730;

export function parseTriggerForm(f: Record<string, string | undefined>): { trigger: Trigger; errors: string[] } {
  const kind = (f["trigger"] ?? "order.paid") as TriggerKind;
  const errors: string[] = [];
  if (!TRIGGERS.some((t) => t.value === kind)) return { trigger: { kind: "order.paid", days: null }, errors: ["きっかけを選んでください"] };
  if (isFavoriteTrigger(kind)) {
    const unit = (["product", "axes", "sku"] as const).find((u) => u === f["variant_unit"]) ?? "product";
    const axes = [...new Set((f["variant_axes"] ?? "").split(",").map((a) => a.trim()).filter((a) => AXIS_RE.test(a)))].slice(0, 3);
    if (unit === "axes" && axes.length === 0) errors.push("「オプションを選ぶ」ときは、オプションを 1 つ以上選んでください");
    return { trigger: { kind, days: null, excludeBought: !!f["exclude_bought"], unit, axes: unit === "axes" ? axes : [] }, errors };
  }
  if (!isTimeTrigger(kind)) return { trigger: { kind, days: null }, errors };
  const raw = (f["trigger_days"] ?? "").trim();
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRIGGER_DAYS) errors.push(`きっかけの日数は 1〜${MAX_TRIGGER_DAYS} 日にしてください`);
  return { trigger: { kind, days: Number.isInteger(n) && n >= 1 && n <= MAX_TRIGGER_DAYS ? n : null }, errors };
}

export function readTrigger(kind: string, days: number | null, optsJson?: string | null): Trigger {
  const k = TRIGGERS.some((t) => t.value === kind) ? (kind as TriggerKind) : "order.paid";
  let opts: Record<string, unknown> = {};
  try {
    opts = JSON.parse(optsJson ?? "{}") as Record<string, unknown>;
  } catch {
    opts = {};
  }
  if (!isFavoriteTrigger(k)) return { kind: k, days: isTimeTrigger(k) ? days : null };
  const unit = (["product", "axes", "sku"] as const).find((u) => u === opts["unit"]) ?? "product";
  const axes = Array.isArray(opts["axes"]) ? opts["axes"].filter((a): a is string => typeof a === "string" && AXIS_RE.test(a)) : [];
  return { kind: k, days: null, excludeBought: opts["exclude_bought"] !== false, unit: unit === "axes" && axes.length === 0 ? "product" : unit, axes: unit === "axes" ? axes : [] };
}

export const triggerOpts = (t: Trigger) =>
  JSON.stringify(isFavoriteTrigger(t.kind) ? { exclude_bought: t.excludeBought !== false, unit: t.unit ?? "product", axes: t.unit === "axes" ? (t.axes ?? []) : [] } : {});

/** 見る単位の説明（「カラーごと」など）。names はショップのオプションの名前の表 */
export function describeUnit(t: Trigger, names: Record<string, string> = {}): string {
  if (t.unit === "sku") return "SKU（オプションの組み合わせ）ごと";
  if (t.unit === "axes" && t.axes && t.axes.length > 0) return `${t.axes.map((a) => names[a] ?? a).join("・")}ごと`;
  return "商品ごと";
}

/** 1 文の頭（「…とき、」） */
export function describeTrigger(t: Trigger, names: Record<string, string> = {}): string {
  if (t.kind === "last_order") return `最後の購入から ${t.days ?? "n"} 日たって、そのあいだ買っていないとき`;
  if (t.kind === "first_order") return `初めての購入から ${t.days ?? "n"} 日たったとき`;
  const bought = (t.unit && t.unit !== "product" ? `（${describeUnit(t, names)}）` : "") + (t.excludeBought !== false ? "（その商品をまだ買っていない会員）" : "");
  if (t.kind === "favorite_restock") return `お気に入りの商品が再入荷したとき${bought}`;
  if (t.kind === "favorite_price_drop") return `お気に入りの商品が値下げしたとき${bought}`;
  if (t.kind === "favorite_low_stock") return `お気に入りの商品が残りわずかになったとき${bought}`;
  if (t.kind === "checkout_abandoned") return "カゴ落ちしたとき（そのあと買っていない会員）";
  return "会員の注文が支払われたとき";
}
