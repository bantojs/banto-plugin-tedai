/**
 * アクションの列を進める（Cron）。1 行 = ルール × 会員。手順ごとに済んだことを steps に残し、失敗したら残りだけをやり直す。
 * - 外へ出す手順は鍵で重ならないようにする（LINE と Resend は Idempotency-Key = 列の ID、クーポンは Banto が「もう持っている」を飛ばす）
 * - お客様の名前・アドレスは送る直前に Banto から読み、この中だけで使う（D1 に置かない。steps にも残さない）
 * - 失敗は 5・10・20・40 分後にやり直し、5 回で failed
 * - お客様への連絡（LINE・メール）がある列は、夜（ショップの設定、日本時間）は朝まで、お客様ごとの上限（全ルールで 1 日・7 日）を
 *   超えるなら空くまで、列ごと後ろへずらす。7 日ずらしても空かなければ、連絡だけ「上限」で飛ばして残りを行う
 * - 待ち（n 日後）のルールは、行う直前に条件を確かめ直し、崩れていたら（キャンセル・期間を過ぎた）行わない
 */
import { BantoError } from "../banto/client";
import { addOrderTags, customerFavorites, getCustomer, grantCoupon, sendLine, setAttribute, type CustomerView, type LineResult } from "../banto/members";
import { productSnapshot, type ProductSnapshot } from "../banto/catalog";
import { isFavoriteTrigger } from "../rules/triggers";
import { availableIn, readVariant, variantLabel } from "../rules/variants";
import type { Deps } from "../deps";
import { BudgetExceeded } from "../budget";
import { MailError, MailMaybeSent, mailer, redactAddresses } from "../mail/transport";
import { MailAddressError } from "../mail/message";
import { emailFormatOf, placeholdersIn, render, type Actions, type Message } from "../rules/actions";
import { composeHtmlMail, footerText, type MailFooter } from "../mail/html";
import { ConnectionRepo, type Connection } from "../store/connections";
import { getRule, type Rule } from "../store/rules";
import { getKv, getSettings, mailReady, quietUntil, SELF_ORIGIN, type ShopSettings } from "../store/settings";
import { stillMatches } from "../rules/evaluate";
import { unsubscribeToken } from "../unsubscribe";

export const MAX_ATTEMPTS = 5;
/**
 * 行を取ってから終えるまでの持ち時間。Cron の間（5 分）より長くし、遅い送り手で 1 回の Cron が長引いても、
 * 次の Cron が同じ行を取り直さないようにする（SMTP は 1 通 60 秒で打ち切る。src/mail/transport.ts）
 */
export const RUN_LEASE_SECONDS = 900;

export interface Steps {
  attribute?: "done";
  tags?: "done" | "no_order";
  coupon?: { code: string | null };
  /** 待ったあとの確かめ直しを済ませた */
  rechecked?: true;
  /** お気に入りのきっかけ: まだお気に入りで、商品があることを確かめた */
  favorite_checked?: true;
  /** 連絡の結果。channel は実際に使った手段（none = 送らなかった） */
  message?: { channel: "line" | "email" | "none"; result: string; line?: LineResult };
  slack?: "done";
  opmail?: "done";
  /**
   * 鍵の無い外への手順（SMTP のメール・Slack・運営者への SMTP のメール）を始める直前に残す印。
   * 残ったまま取り直したら、送っている途中で Worker が切れたので、送れたかもしれないとして 2 度目は行わない
   */
  sending?: "message" | "slack" | "opmail";
}

interface RunRow {
  shop_id: string;
  id: string;
  rule_id: string;
  customer_id: string;
  order_id: string | null;
  product_id: string | null;
  variant: string | null;
  ref_at: number | null;
  attempts: number;
  steps: string;
  created_at: number;
  due_at: number;
}

export const CAP_GIVE_UP_SECONDS = 7 * 86400;

/** やり直さない理由（会員が消えた・ルールを止めた） */
class Skip extends Error {}

const readSteps = (s: string): Steps => {
  try {
    return JSON.parse(s) as Steps;
  } catch {
    return {};
  }
};

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function messageSummary(steps: Steps): string {
  const m = steps.message;
  if (!m) return "";
  const r: Record<string, string> = {
    sent: "送りました",
    no_line: "LINE と結んでいない",
    not_friend: "公式アカウントの友だちでない",
    quota: "LINE の宣伝の月の上限",
    no_consent: "案内メールの同意が無い",
    no_email: "メールアドレスが無い",
    maybe_sent: "送れたかもしれない（送り手の応答が来なかったので、やり直していません）",
    no_coupon_code: "クーポンのコードが取れなかった",
    favorite_removed: "お気に入りから外していた",
    bought_after: "そのあと買っていた",
    sold_out: "売り切れていた",
    product_gone: "商品が無くなっていた",
    cap: "お客様ごとの上限で送らなかった",
  };
  const ch = m.channel === "line" ? "LINE" : m.channel === "email" ? "メール" : "送らず";
  const via = m.line && m.channel === "email" ? `（LINE: ${r[m.line] ?? m.line}）` : "";
  return `${ch}: ${r[m.result] ?? m.result}${via}`;
}

/**
 * persist: 鍵の無い外への手順（SMTP のメール・Slack・運営者へのメール）を済ませた直後に、済んだ手順を残す
 * （その後で Worker が切れても、次に取り直したときに同じ知らせを 2 度送らない。LINE・Resend は鍵で防ぐ）
 */
async function runOne(
  deps: Deps,
  conn: Connection,
  token: string,
  rule: Rule,
  run: RunRow,
  steps: Steps,
  settings: ShopSettings,
  product: ProductSnapshot | null,
  persist: () => Promise<unknown> = async () => undefined,
  /** 印の書き込み（Cron の上限の手前の余りを使わない: 上限ならその場で止まり、何も送らない） */
  mark: () => Promise<unknown> = persist,
): Promise<void> {
  const a: Actions = rule.actions;
  // 前の回で、鍵の無い手順の途中で切れた: 送れたかもしれないので、やり直さない
  if (steps.sending) {
    const s = steps.sending;
    delete steps.sending;
    if (s === "message" && !steps.message) steps.message = { channel: "email", result: "maybe_sent" };
    if (s === "slack") steps.slack = "done";
    if (s === "opmail") steps.opmail = "done";
  }
  /** 鍵の無い手順: 始める前に印を残し、終わったら（失敗でも）外す。切れたときだけ印が残る */
  const keyless = async <T,>(step: NonNullable<Steps["sending"]>, fn: () => Promise<T>): Promise<T> => {
    steps.sending = step;
    try {
      await mark();
      return await fn();
    } finally {
      delete steps.sending;
    }
  };
  const smtp = deps.config.mail?.transport === "smtp";
  let customer: CustomerView | null = null;
  const needCustomer = !!a.message && !steps.message;
  if (needCustomer) {
    try {
      customer = await getCustomer(deps, token, run.customer_id);
    } catch (e) {
      if (e instanceof BantoError && e.status === 404) throw new Skip("customer_gone");
      throw e;
    }
  }

  if (a.attribute && !steps.attribute) {
    await setAttribute(deps, token, run.customer_id, a.attribute.key, a.attribute.value);
    steps.attribute = "done";
  }
  if (a.order_tags.length > 0 && !steps.tags) {
    if (run.order_id) await addOrderTags(deps, token, run.order_id, a.order_tags);
    steps.tags = run.order_id ? "done" : "no_order";
  }
  if (a.coupon_id && !steps.coupon) {
    steps.coupon = { code: await grantCoupon(deps, token, a.coupon_id, run.customer_id) };
  }

  if (a.message && !steps.message && customer) {
    const m = a.message;
    const values = {
      name: customer.name ?? "お客様",
      shop: conn.shop_name,
      coupon_code: steps.coupon?.code ?? "",
      product_name: product?.name ?? "",
      variant: variantLabel(readVariant(run.variant), product?.option_names),
      // Banto の URL のショップのページは、独自ドメインのショップならそのドメインへ転送される
      product_url: product ? `${deps.config.bantoOrigin}/${encodeURIComponent(conn.shop_slug)}/products/${encodeURIComponent(product.slug)}` : "",
    };
    const usesCode = [m.line_text, m.email_subject, m.email_body].some((t) => placeholdersIn(t).includes("coupon_code"));
    if (usesCode && !steps.coupon?.code) {
      steps.message = { channel: "none", result: "no_coupon_code" };
    } else {
      let line: LineResult | undefined;
      if (m.channel === "line" || m.channel === "line_then_email") {
        line = await sendLine(deps, token, run.customer_id, `tedai-${run.id}`, {
          text: render(m.line_text, values).slice(0, 2000),
          ...(m.line_image_url ? { image_url: m.line_image_url } : {}),
          ...(m.line_button_label && m.line_button_url ? { buttons: { text: m.line_button_label, actions: [{ label: m.line_button_label, url: m.line_button_url }] } } : {}),
        });
        if (line === "sent" || m.channel === "line") steps.message = { channel: line === "sent" ? "line" : "none", result: line };
      }
      if (!steps.message) {
        steps.message = await sendEmail(deps, conn, run, settings, customer, m, values, (send) => (smtp ? keyless("message", send) : send()));
        if (steps.message.channel === "email" && deps.config.mail?.transport === "smtp") await persist();
        if (line) steps.message.line = line;
      }
    }
  }

  if (a.notify_slack && !steps.slack) {
    const url = deps.config.slackWebhookUrl;
    if (!url) throw new Error("slack_not_configured");
    const f = deps.fetch;
    const text = [
      `[手代] ${slackEscape(conn.shop_name)}: ルール「${slackEscape(rule.name)}」に会員 ${run.customer_id} が当たりました`,
      run.order_id ? `注文 ID: ${run.order_id}` : "",
      steps.message ? messageSummary(steps) : "",
    ]
      .filter(Boolean)
      .join("\n");
    const res = await keyless("slack", () => f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(8000) }));
    if (!res.ok) throw new Error(`slack ${res.status}`);
    steps.slack = "done";
    await persist();
  }
  if (a.notify_email && !steps.opmail) {
    if (!deps.config.mail || !settings.operator_email || !settings.mail_from) throw new Error("operator_mail_not_configured");
    const m = mailer(deps.config.mail, { fetch: deps.fetch, sockets: deps.sockets, ehloName: "tedai.invalid" });
    const send = () =>
      m.send({
        shop: { slug: conn.shop_slug, id: conn.shop_id },
        from: settings.mail_from,
        to: settings.operator_email,
        subject: `[手代] ${rule.name}`,
        text: [`ルール「${rule.name}」に会員 ${run.customer_id} が当たりました。`, run.order_id ? `注文 ID: ${run.order_id}` : "", steps.message ? messageSummary(steps) : ""]
          .filter(Boolean)
          .join("\n"),
        idempotencyKey: `tedai-op-${run.id}`,
      });
    try {
      await (smtp ? keyless("opmail", send) : send());
    } catch (e) {
      // 送れたかもしれない: やり直さない（運営者への知らせが 2 通にならないように）
      if (!(e instanceof MailMaybeSent)) throw e;
    }
    steps.opmail = "done";
    if (deps.config.mail?.transport === "smtp") await persist();
  }
}

async function sendEmail(
  deps: Deps,
  conn: Connection,
  run: RunRow,
  settings: ShopSettings,
  customer: CustomerView,
  msg: Message,
  values: Record<string, string>,
  guard: (send: () => Promise<void>) => Promise<void> = (send) => send(),
): Promise<NonNullable<Steps["message"]>> {
  const email = customer.email;
  if (!email) return { channel: "none", result: "no_email" };
  // 特定電子メール法: 宣伝のメールは同意のある人だけ（同意の正は Banto。送る直前に読んだ値）
  if (customer.marketing_consent !== true) return { channel: "none", result: "no_consent" };
  if (!deps.config.mail) throw new Error("mail_not_configured");
  if (!mailReady(settings)) throw new Error("mail_settings_missing");
  const origin = await getKv(deps.db, SELF_ORIGIN);
  if (!origin) throw new Error("self_origin_unknown");
  const unsubscribeUrl = `${origin}/u/${await unsubscribeToken(deps.config.secret, conn.shop_id, run.customer_id)}`;
  const footer: MailFooter = {
    lines: [`送信者: ${settings.sender_name}`, `住所: ${settings.sender_address}`, `お問い合わせ: ${settings.sender_contact}`],
    unsubscribeUrl,
  };
  const subject = render(msg.email_subject, values);
  const body =
    emailFormatOf(msg) === "html"
      ? composeHtmlMail({ subject, source: msg.email_body, values, design: { accent: settings.mail_accent, logoUrl: settings.mail_logo_url, shopName: conn.shop_name }, footer })
      : { text: `${render(msg.email_body, values)}\n${footerText(footer)}\n` };
  const m = mailer(deps.config.mail, { fetch: deps.fetch, sockets: deps.sockets, ehloName: new URL(origin).hostname });
  try {
    await guard(() =>
      m.send({
        shop: { slug: conn.shop_slug, id: conn.shop_id },
        from: settings.mail_from,
        to: email,
        ...(settings.reply_to ? { replyTo: settings.reply_to } : {}),
        subject,
        ...body,
        unsubscribeUrl,
        idempotencyKey: `tedai-${run.id}`,
      }),
    );
  } catch (e) {
    // 送れたかもしれない（SMTP で本文を送った後に応答が無い）: やり直さずに記録する（2 通にしない）
    if (e instanceof MailMaybeSent) return { channel: "email", result: "maybe_sent" };
    throw e;
  }
  return { channel: "email", result: "sent" };
}

/** 期限の来た列を max 行まで進める。進めた行の数を返す */
export async function processRuns(
  deps: Deps,
  max: number,
  budget: { canContinue: () => boolean; rescue: <T>(fn: () => Promise<T>) => Promise<T>; stopped?: () => boolean } = { canContinue: () => true, rescue: (fn) => fn() },
): Promise<number> {
  const db = deps.db;
  const now = deps.now();
  const rows = await db.all<RunRow>(
    `SELECT shop_id, id, rule_id, customer_id, order_id, product_id, variant, ref_at, attempts, steps, created_at, due_at FROM runs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?`,
    [now, max],
  );
  const repo = new ConnectionRepo(db, deps.config.secret);
  for (const run of rows) {
    // Cron の上限の手前（src/budget.ts）。1 行の途中では止めない
    if (!budget.canContinue()) break;
    // 行を取る: 持ち時間だけ期限を延ばし、回数を 1 つ進める（ほかの呼び出しと同じ行を取り合わない。行っている途中で Worker が
    // 切れても、その行は持ち時間の後にだけ取り直され、続けば回数で失敗にする。1 つの行が列の先頭に居座らないように）。
    // 終わり方（finish・later）で回数を元に戻すので、数が進んだまま残るのは途中で切れたときだけ
    const claimed = await db.run(`UPDATE runs SET due_at = ?, attempts = attempts + 1 WHERE shop_id = ? AND id = ? AND status = 'pending' AND due_at = ?`, [
      deps.now() + RUN_LEASE_SECONDS, // 取った時刻から（1 回の Cron の中で前の行に時間がかかっても、持ち時間が減らないように）
      run.shop_id,
      run.id,
      run.due_at,
    ]);
    if (claimed.changes === 0) continue;
    if (run.attempts >= MAX_ATTEMPTS) {
      await budget.rescue(() => db.run(`UPDATE runs SET status = 'failed', last_error = 'interrupted', attempts = ?, updated_at = ? WHERE shop_id = ? AND id = ?`, [run.attempts + 1, now, run.shop_id, run.id]));
      continue;
    }
    const steps = readSteps(run.steps);
    const sentAt = () => (steps.message && steps.message.channel !== "none" ? now : null);
    // 行の終わりの書き込みは、Cron の上限の手前でも書けるようにする（済んだ手順を残さないと、次の回に鍵の無い手順を 2 度行う。src/budget.ts）
    // 終わり方を書くところまで来たら、送ったか・送っていないかは分かっている（送っている途中の印は残さない）
    const finish = (status: string, error: string | null, dueAt = now, attempts = run.attempts) =>
      budget.rescue(() => (delete steps.sending, db.run(
        `UPDATE runs SET status = ?, steps = ?, last_error = ?, due_at = ?, attempts = ?, updated_at = ?, message_sent_at = COALESCE(message_sent_at, ?) WHERE shop_id = ? AND id = ?`,
        [status, JSON.stringify(steps), error, dueAt, attempts, now, sentAt(), run.shop_id, run.id],
      )));
    /** 失敗ではなく、後ろへずらす（やり直しの回数は増やさない） */
    const later = (dueAt: number, reason: string) =>
      budget.rescue(() =>
        db.run(`UPDATE runs SET due_at = ?, last_error = ?, attempts = ?, updated_at = ? WHERE shop_id = ? AND id = ?`, [dueAt, reason, run.attempts, now, run.shop_id, run.id]),
      );
    try {
      const rule = await getRule(db, run.shop_id, run.rule_id);
      if (!rule || rule.status !== "active") throw new Skip("rule_stopped");
      // 待ったあと: 何も行っていなければ、条件を確かめ直す（キャンセル・期間切れ・退会のあとに送らない）
      if (rule.actions.wait_days > 0 && rule.actions.recheck && !steps.rechecked) {
        const cancelled = run.order_id
          ? (await db.first<{ cancelled: number }>(`SELECT cancelled FROM orders WHERE shop_id = ? AND order_id = ?`, [run.shop_id, run.order_id]))?.cancelled === 1
          : false;
        // 「最後の購入から n 日」: 待っているあいだに買っていたら、もう休眠ではない
        const boughtAgain =
          rule.trigger.kind === "last_order" &&
          !!(await db.first<{ x: number }>(
            `SELECT 1 AS x FROM orders WHERE shop_id = ? AND customer_id = ? AND cancelled = 0 AND ordered_at > COALESCE((SELECT ordered_at FROM orders WHERE shop_id = ? AND order_id = ?), 0) LIMIT 1`,
            [run.shop_id, run.customer_id, run.shop_id, run.order_id ?? ""],
          ));
        if (cancelled || boughtAgain || !(await stillMatches(db, rule.condition, run.shop_id, run.customer_id, now))) throw new Skip("condition_lost");
        steps.rechecked = true;
      }
      const settings = await getSettings(db, run.shop_id);
      if (rule.actions.message && !steps.message) {
        const quiet = quietUntil(settings, now);
        if (quiet !== null) {
          await later(quiet, "quiet_hours");
          continue;
        }
        const capUntil = await capFreeAt(db, settings, run.shop_id, run.customer_id, now);
        if (capUntil !== null) {
          if (now - run.created_at >= CAP_GIVE_UP_SECONDS) steps.message = { channel: "none", result: "cap" };
          else {
            await later(capUntil, "customer_cap");
            continue;
          }
        }
      }
      const conn = await repo.get(run.shop_id);
      const token = conn ? await repo.token(run.shop_id) : null;
      if (!conn || !token) throw new Error("not_connected");
      // お気に入りのきっかけ: 行う前に、まだお気に入りか・商品があるか・（再入荷と残りわずかは）在庫があるかを Banto で確かめる
      // （外したことは hooks でしか分からないので、取りこぼしをここで落とす）
      let product: ProductSnapshot | null = null;
      // カゴ落ち: レジを始めたあとに買っていたら行わない（期限切れのあとに決済が済むことがある。注文の写しは突き合わせで追いつく）
      if (rule.trigger.kind === "checkout_abandoned" && Object.keys(steps).length === 0) {
        const bought = await db.first<{ x: number }>(`SELECT 1 AS x FROM orders WHERE shop_id = ? AND customer_id = ? AND ordered_at >= ? LIMIT 1`, [
          run.shop_id,
          run.customer_id,
          run.ref_at ?? run.created_at,
        ]);
        if (bought) throw new Skip("bought_after");
      }
      if (rule.trigger.kind === "checkout_abandoned" && run.product_id) product = await productSnapshot(deps, token, run.product_id);
      if (isFavoriteTrigger(rule.trigger.kind) && run.product_id) {
        product = await productSnapshot(deps, token, run.product_id);
        if (!steps.favorite_checked) {
          if (!product || !product.published) throw new Skip("product_gone");
          const variant = readVariant(run.variant);
          const stock = variant ? availableIn(product.skus, variant) : product.available;
          if (rule.trigger.kind !== "favorite_price_drop" && stock <= 0) throw new Skip("sold_out");
          if (!(await customerFavorites(deps, token, run.customer_id)).has(run.product_id)) throw new Skip("favorite_removed");
          steps.favorite_checked = true;
        }
      }
      const saveSteps = () => db.run(`UPDATE runs SET steps = ? WHERE shop_id = ? AND id = ?`, [JSON.stringify(steps), run.shop_id, run.id]);
      await runOne(deps, conn, token, rule, run, steps, settings, product, () => budget.rescue(saveSteps), saveSteps);
      await finish("done", null);
    } catch (e) {
      if (e instanceof Skip) {
        await finish("skipped", e.message);
        continue;
      }
      // Cron の上限の手前で止めた（src/budget.ts）。済んだ手順（送ったメッセージなど）を残し、やり直しの回数は増やさずに次の回へ。
      // 残さないと、次の回に鍵の無い手順（SMTP のメール・Slack）をもう一度行ってしまう
      // 送り手などが上限の誤りを別の形に包んでも、上限で止めた後なら同じに扱う
      if (e instanceof BudgetExceeded || budget.stopped?.()) {
        await finish("pending", null, now, run.attempts);
        throw e instanceof BudgetExceeded ? e : new BudgetExceeded("total");
      }
      // SMTP の応答・アドレスの形の誤りはお客様のアドレスを含むことがあるので消してから残す
      const code =
        e instanceof BantoError
          ? `banto ${e.status} ${e.code}`
          : e instanceof MailAddressError
            ? "invalid_email"
            : e instanceof MailError
              ? `mail ${e.status}`
              : e instanceof Error
                ? redactAddresses(e.message).slice(0, 200)
                : "unknown";
      const attempts = run.attempts + 1;
      console.error("run failed", run.id, code);
      // 頼み方が違う（項目のキーが無い・クーポンが無い・送り手のアドレスを断られた）ものはやり直しても同じなので止める
      const status = e instanceof BantoError || e instanceof MailError ? e.status : 0;
      const permanent = [400, 403, 404, 409, 422].includes(status);
      if (permanent || attempts >= MAX_ATTEMPTS) await finish("failed", code, now, attempts);
      else await finish("pending", code, now + 300 * 2 ** (attempts - 1), attempts);
    }
  }
  return rows.length;
}

/**
 * お客様ごとの上限（全ルールで 1 日・7 日あたりの連絡の数）。超えていなければ null、超えていれば空く時刻
 */
export async function capFreeAt(db: Deps["db"], s: Pick<ShopSettings, "cap_day" | "cap_week">, shopId: string, customerId: string, now: number): Promise<number | null> {
  let until: number | null = null;
  for (const [cap, window] of [
    [s.cap_day, 86400],
    [s.cap_week, 7 * 86400],
  ] as const) {
    if (cap <= 0) continue;
    const rows = await db.all<{ t: number }>(
      `SELECT message_sent_at AS t FROM runs WHERE shop_id = ? AND customer_id = ? AND message_sent_at >= ? ORDER BY message_sent_at DESC LIMIT ?`,
      [shopId, customerId, now - window, cap],
    );
    // 窓の中に cap 件あれば、そのいちばん古いものが窓を出たときに 1 つ空く
    if (rows.length >= cap) {
      const free = rows[rows.length - 1]!.t + window + 60;
      until = until === null ? free : Math.max(until, free);
    }
  }
  return until;
}
