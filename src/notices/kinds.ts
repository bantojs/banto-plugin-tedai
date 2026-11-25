/**
 * 取引の知らせ（注文のお知らせ）。Banto の同梱メールプラグインの代わりに、手代がお客様（会員もゲストも）にメールで送る。
 * 宣伝ではないので、案内メールの同意・お客様ごとの上限・夜は送らない時間・配信停止のリンクは使わない。
 * そのかわり宣伝を混ぜない（混ぜると特定電子メール法の広告メールになる。画面で注意する）。
 *
 * 知らせの種類と、どの出来事で送るか:
 *   received  ご注文の受付   order.paid（入金の記録で出たものを除く）・order.created（未入金の注文 = 代金引換など）
 *   paid      入金の確認     order.paid の入金の記録（recorded_payment）。既定は送らない（Banto の同梱プラグインも送らない）
 *   shipped   発送           order.shipped
 *   cancelled キャンセル     order.cancelled。既定は送らない
 *
 * 差し込みと必ず入れるものは Banto の「お知らせの文面」（0154）にそろえる。受付と発送は明細（{{order_details}}）が必須。
 * 発送は Banto と同じく追跡番号（{{tracking}}、Banto 0172 の注文の tracking）も必須。番号の無い注文では、
 * ご注文の確認ページ（照会のページ）を案内する。
 */

export type NoticeKind = "received" | "paid" | "shipped" | "cancelled";

export const NOTICE_KINDS: { kind: NoticeKind; label: string; when: string }[] = [
  { kind: "received", label: "ご注文の受付", when: "お支払いが済んだとき（代金引換などの未入金の注文は、注文を確定したとき）" },
  { kind: "paid", label: "入金の確認", when: "代金引換などの未入金の注文に、運営者が入金を記録したとき" },
  { kind: "shipped", label: "発送", when: "Banto の管理画面で「発送済み」にしたとき" },
  { kind: "cancelled", label: "キャンセル", when: "Banto の管理画面で「キャンセル」にしたとき" },
];

export const isNoticeKind = (v: string): v is NoticeKind => NOTICE_KINDS.some((k) => k.kind === v);
export const noticeLabel = (k: NoticeKind) => NOTICE_KINDS.find((x) => x.kind === k)!.label;

/** 差し込み（文字）。name は注文のお名前（無ければ「お客様」） */
export const NOTICE_PLACEHOLDERS = ["name", "shop", "order_number", "order_total", "order_url", "payment_method", "contact"] as const;
/** かたまりの差し込み（1 行に単独で） */
export const NOTICE_SLOTS = ["order_details", "tracking"] as const;

/** 必ず入れる差し込み（本文） */
export const REQUIRED: Record<NoticeKind, string[]> = {
  received: ["order_details"],
  paid: [],
  shipped: ["order_details", "tracking"],
  cancelled: [],
};

/** 出来事 → 知らせの種類（送らないものは null） */
export function kindOf(event: string, data: Record<string, unknown>): NoticeKind | null {
  switch (event) {
    case "order.created":
      // 決済の注文は order.paid と同時に出るので、受付は order.paid で送る。order.created で送るのは未入金の注文だけ
      return data["payment_status"] === "unpaid" ? "received" : null;
    case "order.paid":
      // 未入金の注文の入金の記録で出た order.paid には、受付を重ねて送らない（受付は注文のときに送っている）
      return data["recorded_payment"] === true ? "paid" : "received";
    case "order.shipped":
      return "shipped";
    case "order.cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** 知らせの種類を送るのに Banto から購読しておく出来事 */
export const EVENTS_FOR: Record<NoticeKind, string[]> = {
  received: ["order.paid", "order.created"],
  paid: ["order.paid"],
  shipped: ["order.shipped"],
  cancelled: ["order.cancelled"],
};

export interface NoticeTemplate {
  kind: NoticeKind;
  enabled: boolean;
  format: "text" | "html";
  subject: string;
  body: string;
}

/** 既定の文面（Banto の同梱メールプラグインの文面にそろえる） */
export const DEFAULT_TEXTS: Record<NoticeKind, { subject: string; body: string }> = {
  received: {
    subject: "【{{shop}}】ご注文ありがとうございます（注文番号 {{order_number}}）",
    body: "{{name}} 様\n\nご注文を承りました。内容をご確認ください。\n\n{{order_details}}\n\nご注文の状況はこちらから確認できます。\n{{order_url}}\n\nお問い合わせ: {{contact}}\n\n{{shop}}",
  },
  paid: {
    subject: "【{{shop}}】ご入金を確認しました（注文番号 {{order_number}}）",
    body: "{{name}} 様\n\nご注文（注文番号 {{order_number}}）のお支払い {{order_total}} を確認しました。ありがとうございます。\n\n{{order_url}}\n\nお問い合わせ: {{contact}}\n\n{{shop}}",
  },
  shipped: {
    subject: "【{{shop}}】ご注文の商品を発送しました（注文番号 {{order_number}}）",
    body: "{{name}} 様\n\nご注文の商品を発送しました。到着までしばらくお待ちください。\n\n{{tracking}}\n\n{{order_details}}\n\nご注文の状況はこちらから確認できます。\n{{order_url}}\n\nお問い合わせ: {{contact}}\n\n{{shop}}",
  },
  cancelled: {
    subject: "【{{shop}}】ご注文をキャンセルしました（注文番号 {{order_number}}）",
    body: "{{name}} 様\n\nご注文（注文番号 {{order_number}}）をキャンセルしました。お支払い済みの場合は、お支払いの方法で返金します。\n\n{{order_url}}\n\nお問い合わせ: {{contact}}\n\n{{shop}}",
  },
};

/** 飾りあり（HTML）の既定の文面（決まった書き方。src/mail/html.ts） */
export const DEFAULT_HTML: Record<NoticeKind, string> = {
  received: "# ご注文ありがとうございます\n{{name}} 様\n\nご注文を承りました。内容をご確認ください。\n\n{{order_details}}\n\n[[ご注文の状況を見る]]({{order_url}})\n\nお問い合わせ: {{contact}}",
  paid: "# ご入金を確認しました\n{{name}} 様\n\nご注文（注文番号 {{order_number}}）のお支払い {{order_total}} を確認しました。ありがとうございます。\n\n[[ご注文の状況を見る]]({{order_url}})\n\nお問い合わせ: {{contact}}",
  shipped: "# ご注文の商品を発送しました\n{{name}} 様\n\n到着までしばらくお待ちください。\n\n{{tracking}}\n\n{{order_details}}\n\n[[ご注文の状況を見る]]({{order_url}})\n\nお問い合わせ: {{contact}}",
  cancelled: "# ご注文をキャンセルしました\n{{name}} 様\n\nご注文（注文番号 {{order_number}}）をキャンセルしました。お支払い済みの場合は、お支払いの方法で返金します。\n\n[[ご注文を見る]]({{order_url}})\n\nお問い合わせ: {{contact}}",
};

export const defaultTemplate = (kind: NoticeKind): NoticeTemplate => ({ kind, enabled: false, format: "text", ...DEFAULT_TEXTS[kind] });

const placeholdersIn = (text: string) => [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!);

/** 画面の値を確かめる。誤りは画面に出す文 */
export function checkTemplate(t: NoticeTemplate, parseErrors: string[]): string[] {
  const errors: string[] = [];
  if (!t.subject) errors.push("件名を入れてください");
  if (!t.body) errors.push("本文を入れてください");
  const known = [...NOTICE_PLACEHOLDERS, ...NOTICE_SLOTS] as readonly string[];
  const used = [...placeholdersIn(t.subject), ...placeholdersIn(t.body)];
  const unknown = [...new Set(used.filter((p) => !known.includes(p)))];
  if (unknown.length > 0) errors.push(`使えない差し込みがあります: ${unknown.map((u) => `{{${u}}}`).join(" ")}`);
  for (const p of placeholdersIn(t.subject)) if ((NOTICE_SLOTS as readonly string[]).includes(p)) errors.push(`{{${p}}} は件名には使えません`);
  const inBody = placeholdersIn(t.body);
  for (const r of REQUIRED[t.kind]) {
    const n = inBody.filter((p) => p === r).length;
    if (n === 0) errors.push(`本文に {{${r}}} を必ず入れてください`);
    else if (n > 1 && (NOTICE_SLOTS as readonly string[]).includes(r)) errors.push(`{{${r}}} は 1 回だけにしてください`);
  }
  errors.push(...parseErrors);
  return errors;
}
