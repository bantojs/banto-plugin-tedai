/**
 * ルールのアクション（決まった形だけ）。行う順は 会員の項目 → 注文に印 → クーポン → お客様への連絡 → 運営者への知らせ。
 * 文の差し込みは {{name}}（会員の名前）・{{shop}}（ショップの名前）・{{coupon_code}}（このルールで配ったクーポンのコード）、
 * お気に入りのきっかけでは {{product_name}}・{{product_url}}（その商品）も。
 */
import { parseMailBody } from "../mail/html";

export type Channel = "line_then_email" | "line" | "email";
/** メールの形: text = 文字だけ（今まで）/ html = 飾りあり（決まった書き方の本文を手代のレイアウトに流し込む。src/mail/html.ts） */
export type EmailFormat = "text" | "html";

export const EMAIL_FORMATS: { value: EmailFormat; label: string }[] = [
  { value: "text", label: "文字だけ" },
  { value: "html", label: "飾りあり（HTML）" },
];

/** 保存済みのルール（email_format が無いもの）は文字だけ */
export const emailFormatOf = (m: Pick<Message, "email_format">): EmailFormat => (m.email_format === "html" ? "html" : "text");

export interface Message {
  channel: Channel;
  line_text: string;
  line_image_url: string | null;
  line_button_label: string | null;
  line_button_url: string | null;
  email_subject: string;
  email_body: string;
  email_format?: EmailFormat;
}

export interface Actions {
  attribute: { key: string; value: string } | null;
  order_tags: string[];
  coupon_id: string | null;
  message: Message | null;
  notify_slack: boolean;
  notify_email: boolean;
  /** 当たってから行うまでの日数（0 = すぐ） */
  wait_days: number;
  /** 待ったあと、行う直前に条件を確かめ直す（崩れていたら行わない） */
  recheck: boolean;
}

export const MAX_WAIT_DAYS = 90;

export const NO_ACTIONS: Actions = { attribute: null, order_tags: [], coupon_id: null, message: null, notify_slack: false, notify_email: false, wait_days: 0, recheck: true };

export const CHANNELS: { value: Channel; label: string }[] = [
  { value: "line_then_email", label: "LINE、届かなければメール" },
  { value: "line", label: "LINE だけ" },
  { value: "email", label: "メールだけ" },
];

export const PLACEHOLDERS = ["name", "shop", "coupon_code", "product_name", "product_url", "variant"] as const;
/** お気に入りのきっかけのときだけ使える差し込み（variant は見る単位のオプション。商品ごとなら空） */
export const PRODUCT_PLACEHOLDERS = ["product_name", "product_url", "variant"];

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function readActions(json: string | null | undefined): Actions {
  try {
    const v = JSON.parse(json ?? "{}") as Partial<Actions>;
    return {
      attribute: v.attribute ?? null,
      order_tags: Array.isArray(v.order_tags) ? v.order_tags : [],
      coupon_id: v.coupon_id ?? null,
      message: v.message ?? null,
      notify_slack: v.notify_slack === true,
      notify_email: v.notify_email === true,
      wait_days: typeof v.wait_days === "number" && Number.isInteger(v.wait_days) && v.wait_days >= 0 && v.wait_days <= MAX_WAIT_DAYS ? v.wait_days : 0,
      recheck: v.recheck !== false,
    };
  } catch {
    return { ...NO_ACTIONS };
  }
}

export const hasAny = (a: Actions) => !!(a.attribute || a.order_tags.length > 0 || a.coupon_id || a.message || a.notify_slack || a.notify_email);

/** 使っている差し込みの名前 */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!);
}

export function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => (k in values ? values[k]! : all));
}

const httpsUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && v.length <= 1000;
  } catch {
    return false;
  }
};

export interface ActionContext {
  /** お気に入りのきっかけ（{{product_name}}・{{product_url}} が使える） */
  productTrigger?: boolean;
  mailTransport: boolean;
  mailSettings: boolean;
  operatorEmail: boolean;
  slack: boolean;
}

/** 画面のフォームから組み立てる。誤りは画面に出す文 */
export function parseActionsForm(f: Record<string, string | undefined>, ctx: ActionContext): { actions: Actions; errors: string[] } {
  const errors: string[] = [];
  const a: Actions = { ...NO_ACTIONS, order_tags: [] };
  const v = (k: string) => (f[k] ?? "").trim();

  if (f["attr_on"]) {
    const key = v("attr_key");
    const value = v("attr_value").slice(0, 200);
    if (!KEY_RE.test(key)) errors.push("会員の項目のキーは英小文字で始まる英数字と _ にしてください（Banto の「会員の項目」のキー）");
    else a.attribute = { key, value };
  }
  if (f["tags_on"]) {
    const tags = v("order_tags")
      .split(/[、,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0 || tags.length > 5 || tags.some((t) => t.length > 40)) errors.push("注文の印は 1〜5 個、1 つ 40 文字までにしてください");
    else a.order_tags = [...new Set(tags)];
  }
  if (f["coupon_on"]) {
    const id = v("coupon_id");
    if (!ID_RE.test(id)) errors.push("配るクーポンを選んでください");
    else a.coupon_id = id;
  }
  if (f["message_on"]) {
    const channel = v("channel") as Channel;
    const m: Message = {
      channel,
      line_text: (f["line_text"] ?? "").trim().slice(0, 1500),
      line_image_url: v("line_image_url") || null,
      line_button_label: v("line_button_label") || null,
      line_button_url: v("line_button_url") || null,
      email_subject: v("email_subject").replace(/[\r\n]+/g, " ").slice(0, 150),
      email_body: (f["email_body"] ?? "").replace(/\r\n/g, "\n").trim().slice(0, 5000),
      email_format: f["email_format"] === "html" ? "html" : "text",
    };
    if (!CHANNELS.some((c) => c.value === channel)) errors.push("連絡の手段を選んでください");
    const usesLine = channel === "line" || channel === "line_then_email";
    const usesEmail = channel === "email" || channel === "line_then_email";
    if (usesLine) {
      if (!m.line_text) errors.push("LINE の文を入れてください");
      if (m.line_image_url && !httpsUrl(m.line_image_url)) errors.push("LINE の画像は https:// の URL にしてください");
      if (!!m.line_button_label !== !!m.line_button_url) errors.push("LINE のボタンは文字とリンクの両方を入れてください");
      if (m.line_button_label && m.line_button_label.length > 20) errors.push("LINE のボタンの文字は 20 文字までです");
      if (m.line_button_url && !httpsUrl(m.line_button_url)) errors.push("LINE のボタンのリンクは https:// の URL にしてください");
    }
    if (usesEmail) {
      if (!m.email_subject || !m.email_body) errors.push("メールの件名と本文を入れてください");
      if (!ctx.mailTransport) errors.push("メールの送り手が設定されていません（Worker の変数 MAIL_TRANSPORT ほか。README の「メール」）");
      if (!ctx.mailSettings) errors.push("「設定」で送り手のアドレスと特定電子メール法の表示（名前・住所・問い合わせ先）を入れてください");
      if (m.email_format === "html") errors.push(...parseMailBody(m.email_body).errors);
    }
    const used = [...placeholdersIn(m.line_text), ...placeholdersIn(m.email_subject), ...placeholdersIn(m.email_body)];
    const unknown = used.filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p));
    if (unknown.length > 0) errors.push(`知らない差し込みがあります: ${[...new Set(unknown)].map((u) => `{{${u}}}`).join(" ")}`);
    if (used.includes("coupon_code") && !f["coupon_on"]) errors.push("{{coupon_code}} を使うときは、クーポンを配るアクションも選んでください");
    if (!ctx.productTrigger && used.some((p) => PRODUCT_PLACEHOLDERS.includes(p))) errors.push("{{product_name}}・{{product_url}}・{{variant}} は、きっかけがお気に入りの商品かカゴ落ちのときだけ使えます");
    a.message = m;
  }
  if (f["slack_on"]) {
    if (!ctx.slack) errors.push("Slack の Incoming Webhook が設定されていません（Worker のシークレット SLACK_WEBHOOK_URL）");
    else a.notify_slack = true;
  }
  const wait = (f["wait_days"] ?? "").trim();
  if (wait !== "") {
    const n = Number(wait);
    if (!Number.isInteger(n) || n < 0 || n > MAX_WAIT_DAYS) errors.push(`待ちは 0〜${MAX_WAIT_DAYS} 日にしてください`);
    else a.wait_days = n;
  }
  a.recheck = !!f["recheck"];
  if (f["opmail_on"]) {
    if (!ctx.mailTransport || !ctx.operatorEmail) errors.push("運営者へのメールには、メールの送り手と「設定」の運営者の宛先が要ります");
    else a.notify_email = true;
  }
  return { actions: a, errors };
}

/** 画面に出す説明 */
export function describeActions(a: Actions, couponName: (id: string) => string): string[] {
  const out: string[] = [];
  if (a.wait_days > 0) out.push(`${a.wait_days} 日待ってから${a.recheck ? "（条件を確かめ直す）" : ""}`);
  if (a.attribute) out.push(`会員の項目 ${a.attribute.key} を「${a.attribute.value}」にする`);
  if (a.order_tags.length > 0) out.push(`注文に印「${a.order_tags.join("」「")}」を付ける`);
  if (a.coupon_id) out.push(`クーポン「${couponName(a.coupon_id)}」を配る`);
  if (a.message) out.push(CHANNELS.find((c) => c.value === a.message!.channel)?.label ?? "連絡する");
  if (a.notify_slack) out.push("Slack に知らせる");
  if (a.notify_email) out.push("運営者にメールで知らせる");
  return out;
}
