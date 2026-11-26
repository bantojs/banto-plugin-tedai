/**
 * 取引の知らせを送る。出来事を受け取ったら列に積み（src/events.ts）、受け取りの応答の後と Cron（5 分ごと）で送る。
 * - 宛先・お名前は送る直前に Banto（orders:contact）から読み、この中だけで使う（D1 に置かない。記録には注文 ID と番号だけ）
 * - 同じ注文 × 種類は 1 回（列の主キー）。Resend には Idempotency-Key も付ける
 * - お店で試着の知らせは、列の order_id に申し込みの ID（延長は延長の回数を足したもの）、order_number に受付番号を置き、
 *   送る直前に受付番号で申し込みを読む（src/notices/tryon.ts）
 * - 失敗は 5・10・20・40 分後にやり直し、5 回で failed（画面から送り直せる）
 */
import { BantoError } from "../banto/client";
import { BudgetExceeded } from "../budget";
import type { Deps } from "../deps";
import { composeHtmlMail, footerText, type MailDesign, type MailFooter, type Slots } from "../mail/html";
import { MailAddressError } from "../mail/message";
import { MailError, MailMaybeSent, mailer, permanentMailError, redactAddresses } from "../mail/transport";
import { ConnectionRepo, type Connection } from "../store/connections";
import { dueNotices, finishNotice, listTemplates, type NoticeSendRow } from "../store/notices";
import { getSettings, type ShopSettings } from "../store/settings";
import { defaultTemplate, noticeGroup, NOTICE_SLOTS, type NoticeKind, type NoticeTemplate } from "./kinds";
import { getOrderView, orderSlots, paymentLabel, SAMPLE_ORDER, yen, type OrderView } from "./order";
import { getStoreView, getTryonView, SAMPLE_STORE, SAMPLE_TRYON, todayJst, tryonSlots, tryonValues, type StoreView, type TryonView } from "./tryon";

export const MAX_NOTICE_ATTEMPTS = 5;

/** 注文照会のページ（Banto。独自ドメインのショップならそのドメイン・連携サイトのページへ Banto が移す）。秘密は載せない */
export function orderUrl(bantoOrigin: string, shopSlug: string, o: Pick<OrderView, "number" | "customer_id">): string {
  return `${bantoOrigin}/${encodeURIComponent(shopSlug)}/orders/lookup?banto_order=${o.number}${o.customer_id ? "&banto_member=1" : ""}`;
}

/** 知らせの最後の表示（取引の知らせなので配信停止のリンクは付けない。入れてある分だけ） */
export function noticeFooter(s: ShopSettings): MailFooter {
  return {
    lines: [s.sender_name ? `送信者: ${s.sender_name}` : "", s.sender_address ? `住所: ${s.sender_address}` : "", s.sender_contact ? `お問い合わせ: ${s.sender_contact}` : ""].filter(Boolean),
  };
}

/** 差し込みの値とかたまりから、件名・文字だけの版・（飾りありなら）HTML を作る（注文と試着で共通） */
function composeWith(t: NoticeTemplate, values: Record<string, string>, slots: Slots, ctx: { shopName: string; settings: ShopSettings }): { subject: string; text: string; html?: string } {
  const s = ctx.settings;
  const fill = (text: string, extra: Record<string, string> = {}) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => (k in extra ? extra[k]! : k in values ? values[k]! : all));
  const subject = fill(t.subject).replace(/[\r\n]+/g, " ").slice(0, 200);
  const footer = noticeFooter(s);
  if (t.format === "html") {
    const design: MailDesign = { accent: s.mail_accent, logoUrl: s.mail_logo_url, shopName: ctx.shopName };
    const { html, text } = composeHtmlMail({ subject, source: t.body, values, design, footer, slots });
    return { subject, text, html };
  }
  const textSlots = Object.fromEntries(Object.entries(slots).map(([n, v]) => [n, v.text]));
  return { subject, text: `${fill(t.body, textSlots)}\n${footerText(footer)}\n` };
}

const contactOf = (s: ShopSettings) => s.sender_contact || s.reply_to || "";

/** 文面と注文から、件名・文字だけの版・（飾りありなら）HTML を作る */
export function composeNotice(t: NoticeTemplate, o: OrderView, ctx: { shopName: string; orderUrl: string; settings: ShopSettings }): { subject: string; text: string; html?: string } {
  const values: Record<string, string> = {
    name: o.name ?? "お客様",
    shop: ctx.shopName,
    order_number: String(o.number),
    order_total: yen(o.total_jpy),
    order_url: ctx.orderUrl,
    payment_method: paymentLabel(o),
    contact: contactOf(ctx.settings),
  };
  const all = orderSlots(o, ctx.orderUrl);
  return composeWith(t, values, Object.fromEntries(NOTICE_SLOTS.map((n) => [n, all[n] ?? { html: "", text: "" }])), ctx);
}

/** お店のトップ（Banto。独自ドメインのショップなら Banto がそのドメインへ移す） */
export const shopUrl = (bantoOrigin: string, shopSlug: string) => `${bantoOrigin}/${encodeURIComponent(shopSlug)}`;

/** 文面と試着の申し込みから、件名・文字だけの版・（飾りありなら）HTML を作る */
export function composeTryonNotice(t: NoticeTemplate, r: TryonView, store: StoreView | null, ctx: { shopName: string; shopUrl: string; settings: ShopSettings; today: string }): { subject: string; text: string; html?: string } {
  const values: Record<string, string> = { name: r.name ?? "お客様", shop: ctx.shopName, contact: contactOf(ctx.settings), shop_url: ctx.shopUrl, ...tryonValues(r) };
  return composeWith(t, values, tryonSlots(r, store, ctx.today), ctx);
}

/** 見本の注文・申し込みで作る（画面の見本と試し送り） */
export function sampleNotice(t: NoticeTemplate, ctx: { shopName: string; shopSlug: string; bantoOrigin: string; settings: ShopSettings; now: number }): { subject: string; text: string; html?: string } {
  if (noticeGroup(t.kind) === "tryon") {
    return composeTryonNotice(t, SAMPLE_TRYON, SAMPLE_STORE, { shopName: ctx.shopName, shopUrl: shopUrl(ctx.bantoOrigin, ctx.shopSlug), settings: ctx.settings, today: todayJst(ctx.now) });
  }
  return composeNotice(t, SAMPLE_ORDER, { shopName: ctx.shopName, orderUrl: orderUrl(ctx.bantoOrigin, ctx.shopSlug, SAMPLE_ORDER), settings: ctx.settings });
}

class Terminal extends Error {
  constructor(
    readonly status: "skipped" | "failed",
    readonly result: string,
    readonly detail: string | null = null,
  ) {
    super(result);
  }
}

/** 1 回の処理の中で、ショップごとに 1 回だけ読むもの（D1 の問い合わせを数えて上限に収めるため） */
interface ShopCtx {
  conn: Connection;
  token: string | null;
  settings: ShopSettings;
  templates: Map<NoticeKind, NoticeTemplate>;
}

async function shopCtx(deps: Deps, cache: Map<string, ShopCtx | null>, shopId: string): Promise<ShopCtx | null> {
  if (cache.has(shopId)) return cache.get(shopId)!;
  // ショップごとに D1 を 3 回（接続とトークン・設定・文面すべて）
  const found = await new ConnectionRepo(deps.db, deps.config.secret).getWithToken(shopId);
  const ctx = found
    ? { conn: found.connection, token: found.token, settings: await getSettings(deps.db, shopId), templates: new Map((await listTemplates(deps.db, shopId)).map((t) => [t.kind, t] as const)) }
    : null;
  cache.set(shopId, ctx);
  return ctx;
}

async function sendOne(deps: Deps, ctx: ShopCtx, row: NoticeSendRow): Promise<{ result: string; order_number: number }> {
  const t = ctx.templates.get(row.kind) ?? defaultTemplate(row.kind);
  // 積んだあとに「送らない」にした
  if (!t.enabled) throw new Terminal("skipped", "disabled");
  const settings = ctx.settings;
  if (!deps.config.mail) throw new Error("mail_not_configured");
  if (!settings.mail_from) throw new Error("mail_from_missing");
  if (!ctx.token) throw new Error("token_unavailable");
  const built = noticeGroup(row.kind) === "tryon" ? await buildTryon(deps, ctx, ctx.token, t, row) : await buildOrder(deps, ctx, ctx.token, t, row);
  const transport = deps.config.mail.transport;
  // SMTP には重なりを防ぐ鍵が無い: 送り始める前に印を残す（送っている途中で Worker が切れたら、取り直しで送り直さない）
  if (transport === "smtp") {
    await deps.db.run(`UPDATE notice_sends SET sending_at = ? WHERE shop_id = ? AND order_id = ? AND kind = ?`, [deps.now(), row.shop_id, row.order_id, row.kind]);
  }
  const m = mailer(deps.config.mail, { fetch: deps.fetch, sockets: deps.sockets, ehloName: "tedai.invalid" });
  try {
    await m.send({
      shop: { slug: ctx.conn.shop_slug, id: ctx.conn.shop_id },
      from: settings.mail_from,
      to: built.to,
      ...(settings.reply_to ? { replyTo: settings.reply_to } : {}),
      ...built.mail,
      idempotencyKey: `tedai-n-${row.shop_id}-${row.order_id}-${row.kind}`,
    });
  } catch (e) {
    // 送れたかもしれない（SMTP で本文を送った後に応答が無い）。やり直すと 2 通になりうるので、まとめての送り直しにも入れない
    if (e instanceof MailMaybeSent) throw new Terminal("failed", "maybe_sent", "interrupted");
    // 手代が送れない形のアドレス（Banto のレジは通る , ; などを含む）。やり直しても同じ
    if (e instanceof MailAddressError) throw new Terminal("skipped", "invalid_email");
    // 送り手に断られた（宛先が無い・送り元のドメインが確かめられていない など）。やり直しても同じ。応答の文はアドレスを含むことがあるので残さない
    if (e instanceof MailError && permanentMailError(transport, e.status)) throw new Terminal("failed", "rejected", `${transport} ${e.status}`);
    throw e;
  }
  return { result: "sent", order_number: built.number };
}

type Built = { to: string; number: number; mail: { subject: string; text: string; html?: string } };

async function buildOrder(deps: Deps, ctx: ShopCtx, token: string, t: NoticeTemplate, row: NoticeSendRow): Promise<Built> {
  let o: OrderView | null;
  try {
    o = await getOrderView(deps, token, row.order_id);
  } catch (e) {
    if (e instanceof BantoError && e.status === 404) throw new Terminal("skipped", "order_not_found");
    throw e;
  }
  if (!o) throw new Error("order_unreadable");
  // orders:pii が無いつなぎ方（前の版の手代でつないだ）。つなぎ直すまで宛先が分からない
  if (!o.pii) throw new Terminal("failed", "no_pii");
  if (!o.email) throw new Terminal("skipped", "no_email");
  return { to: o.email, number: o.number, mail: composeNotice(t, o, { shopName: ctx.conn.shop_name, orderUrl: orderUrl(deps.config.bantoOrigin, ctx.conn.shop_slug, o), settings: ctx.settings }) };
}

async function buildTryon(deps: Deps, ctx: ShopCtx, token: string, t: NoticeTemplate, row: NoticeSendRow): Promise<Built> {
  // 受付番号は積んだときに hooks から置いた（無ければ読めない）
  if (!row.order_number) throw new Terminal("skipped", "tryon_not_found");
  let r: TryonView | null;
  try {
    r = await getTryonView(deps, token, row.order_number);
  } catch (e) {
    // 404: 申し込みが無い・お店で試着を OFF にした。403: 古い Banto（試着の API が無い）
    if (e instanceof BantoError && (e.status === 404 || e.status === 403)) throw new Terminal("skipped", "tryon_not_found");
    throw e;
  }
  if (!r) throw new Error("tryon_unreadable");
  if (!r.pii) throw new Terminal("failed", "no_pii");
  if (!r.email) throw new Terminal("skipped", "no_email");
  // 積んだ後に状態が変わった（取り置きの前に取り消した など）。古い知らせは送らない
  if (row.kind !== "tryon_requested" && row.kind !== "tryon_cancelled" && r.status !== "ready") throw new Terminal("skipped", "tryon_changed");
  if (row.kind === "tryon_cancelled" && r.status !== "cancelled") throw new Terminal("skipped", "tryon_changed");
  const store = await getStoreView(deps, token, r.store_id);
  return {
    to: r.email,
    number: r.number,
    mail: composeTryonNotice(t, r, store, { shopName: ctx.conn.shop_name, shopUrl: shopUrl(deps.config.bantoOrigin, ctx.conn.shop_slug), settings: ctx.settings, today: todayJst(deps.now()) }),
  };
}

/** 記録とログに残すエラーの文（お客様のアドレスを含めない。送り手の応答の文は残さない） */
function errorText(e: unknown): string {
  if (e instanceof MailError) return `mail ${e.status}`;
  if (e instanceof BantoError) return `banto ${e.status} ${redactAddresses(e.code)}`.slice(0, 200);
  return e instanceof Error ? redactAddresses(e.message).slice(0, 200) : "unknown";
}

/** 取ってから送り終えるまでの持ち時間（SMTP の遅い応答 15 秒 × 数回より長く）。過ぎたら切れたものとして取り直す（1 回と数える） */
export const NOTICE_LEASE_SECONDS = 900;

/** 1 通の D1 の問い合わせ（取る・SMTP の送っている途中の印・終える）と、ショップを初めて読むときの分 */
const QUERIES_PER_ROW = 3;
const QUERIES_PER_SHOP = 3;

/**
 * 期限の来た知らせを max 通まで送る（shopId を渡せばそのショップだけ）。送った・やめた行の数を返す。
 * D1 の問い合わせは 1 + 通数 × 3 + ショップごとに 3。maxQueries を渡せば、それを超える前に止める
 * （Cron は 1 回の呼び出しの上限（無料プランは 50）をほかの仕事と分け合うため）
 */
export async function processNotices(deps: Deps, max: number, opts: { shopId?: string; maxQueries?: number } = {}): Promise<number> {
  const rows = await dueNotices(deps.db, deps.now(), max, opts.shopId);
  const cache = new Map<string, ShopCtx | null>();
  let used = 1;
  let n = 0;
  for (const row of rows) {
    const need = QUERIES_PER_ROW + (cache.has(row.shop_id) ? 0 : QUERIES_PER_SHOP);
    if (opts.maxQueries !== undefined && used + need > opts.maxQueries) break;
    used += need;
    const now = deps.now();
    // 同時に 2 か所（受け取りの後と Cron）で送らないよう、先に期限を延ばして取る。取ったら 1 回と数える
    // （送っている途中で Worker が切れても、取り直しのたびに数が進み、いつか失敗で止まる）
    const claimed = await deps.db.run(
      `UPDATE notice_sends SET due_at = ?, attempts = attempts + 1, updated_at = ? WHERE shop_id = ? AND order_id = ? AND kind = ? AND status = 'pending' AND due_at = ?`,
      [now + NOTICE_LEASE_SECONDS, now, row.shop_id, row.order_id, row.kind, row.due_at],
    );
    if (claimed.changes === 0) continue;
    const attempts = row.attempts + 1;
    if (row.sending_at !== null && row.sending_at !== undefined) {
      // 前の回に SMTP で送っている途中で切れた: 届いたかもしれないので送り直さない（まとめての送り直しにも入れない）
      await finishNotice(deps.db, row, { status: "failed", result: "maybe_sent", attempts, last_error: "interrupted" }, now);
      n++;
      continue;
    }
    if (row.attempts >= MAX_NOTICE_ATTEMPTS) {
      // 前の回で取ったまま終わらなかった（Worker が切れた）が続いた
      await finishNotice(deps.db, row, { status: "failed", result: "error", attempts, last_error: "interrupted" }, now);
      n++;
      continue;
    }
    try {
      const ctx = await shopCtx(deps, cache, row.shop_id);
      if (!ctx) throw new Terminal("skipped", "not_connected");
      const r = await sendOne(deps, ctx, row);
      await finishNotice(deps.db, row, { status: "done", result: r.result, order_number: r.order_number, attempts, last_error: null }, now);
      n++;
    } catch (e) {
      // Cron の上限の手前で止めた（src/budget.ts）。取った行は持ち時間の後に取り直す（1 回と数えてある）。
      // 上限で止まるのは送り手に通信する前（接続を数えるところ）なので、送っている途中の印を外しておく（外せなければ、送れたかもしれないになる）
      if (e instanceof BudgetExceeded) {
        await deps.db.run(`UPDATE notice_sends SET sending_at = NULL WHERE shop_id = ? AND order_id = ? AND kind = ?`, [row.shop_id, row.order_id, row.kind]).catch(() => undefined);
        throw e;
      }
      if (e instanceof Terminal) {
        await finishNotice(deps.db, row, { status: e.status, result: e.result, attempts, last_error: e.detail }, now);
        n++;
        continue;
      }
      const msg = errorText(e);
      console.error("notice failed", row.kind, msg);
      if (attempts >= MAX_NOTICE_ATTEMPTS) await finishNotice(deps.db, row, { status: "failed", result: "error", attempts, last_error: msg }, now);
      else await finishNotice(deps.db, row, { status: "pending", attempts, due_at: now + 300 * 2 ** (attempts - 1), last_error: msg }, now);
    }
  }
  return n;
}

/** 記録の結果を画面の文に */
export const NOTICE_RESULTS: Record<string, string> = {
  sent: "送った",
  disabled: "送らない設定にした",
  line_only: "お客様が「LINE だけ」を選んでいる（Banto が LINE で送る）",
  order_not_found: "注文が見つからない",
  tryon_not_found: "試着のお申し込みが見つからない",
  tryon_changed: "送る前にお申し込みの状態が変わった",
  no_pii: "宛先を読めない（つなぎ直しが要る）",
  no_email: "メールアドレスが無い",
  invalid_email: "送れない形のメールアドレス",
  rejected: "送り手に断られた（やり直しても同じ）",
  maybe_sent: "送れたかもしれない（送り手の応答が来なかった。お客様に届いたか確かめてから送り直してください）",
  not_connected: "つないでいない",
  error: "送れなかった（途中で切れたものは送れていたかもしれません。お客様に届いていないか確かめてから送り直してください）",
};
