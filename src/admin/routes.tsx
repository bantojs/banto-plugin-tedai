/** @jsxImportSource hono/jsx */
/**
 * 管理画面の商品の集まりとルール。どの要求も手代の作業の券（s）を確かめる。
 * POST は本文の s を確かめる（よそのサイトからは券が分からないので、これが CSRF の守りにもなる）。Origin があれば手代自身に限る。
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { BantoError } from "../banto/client";
import { listCategories, productsInCategory, searchProducts, withDescendants, type ProductRef } from "../banto/catalog";
import { isRuleStatus, parseConditionForm, MAX_RUNNING_RULES, RUNNING_STATUSES } from "../rules/condition";
import { hasProduct, isFavoriteTrigger, isTimeTrigger, parseTriggerForm } from "../rules/triggers";
import { lastAbandonedKey } from "../rules/abandoned";
import { previewCustomers } from "../rules/evaluate";
import { optionNamesKey, previewFavorites } from "../rules/favorites";
import { previewTime } from "../rules/time-scan";
import { preview } from "../rules/evaluate";
import { explain } from "../rules/explain";
import { ConnectionRepo, type Connection } from "../store/connections";
import { ensureMigrated } from "../store/migrations";
import {
  addSetItems,
  createSet,
  deleteRule,
  deleteSet,
  getRule,
  getSet,
  listHits,
  listRules,
  listSets,
  removeSetItems,
  renameSet,
  saveRule,
  type SetItem,
} from "../store/rules";
import { expired, page, type C, type Env } from "./http";
import { AllRunsPage, CheckPage, HitsPage, RuleEditPage, RulesPage, RunsPage, SetEditPage, SetsPage, SettingsPage, ruleToForm, type ActionChoices, type RuleForm } from "./pages";
import { listCoupons, type CouponRef } from "../banto/members";
import { loadPeople } from "./people";
import { domainsFor, fromAllowed, MailError, mailer } from "../mail/transport";
import { hasAny, parseActionsForm } from "../rules/actions";
import { messageSummary, type Steps } from "../runs/execute";
import { getKv, getSettings, mailReady, parseSettingsForm, saveSettings, setKv, SELF_ORIGIN, takeSlot } from "../store/settings";
import { verifySession } from "./session";
import { readForm as readFormLimited } from "../http-body";
import { allowUser, listAdminUsers, removeUser, roleOf, transferOwner } from "../store/admin-users";
import { NoticeEditPage, NoticesPage, kindParam, noticeReady, type NoticeReadiness } from "./notices";
import { checkTemplate, defaultTemplate, slotsFor, type NoticeTemplate } from "../notices/kinds";
import { parseMailBody } from "../mail/html";
import { sampleNotice } from "../notices/send";
import { countFailed, retryFailedNotices } from "../store/notices";
import { defaultBody, getTemplate, listTemplates, recentNotices, retryNotice, saveTemplate } from "../store/notices";

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** 注文のお知らせの試し送りの間隔（秒、ショップごと） */
export const TEST_SEND_INTERVAL = 30;

interface Ctx {
  s: string;
  shopId: string;
  connection: Connection;
  userId: string;
  role: "owner" | "member";
}

async function sessionFrom(c: C, s: string | undefined): Promise<Ctx | null> {
  if (!s) return null;
  const deps = c.env;
  await ensureMigrated(deps.db);
  const sess = await verifySession(deps.config.secret, s, deps.now());
  if (!sess) return null;
  const conn = await new ConnectionRepo(deps.db, deps.config.secret).get(sess.shop_id);
  if (!conn || conn.endpoint_id !== sess.endpoint_id) return null;
  // 持ち主と、持ち主が許した人だけ（許しを外されたら、券の期限の前でも使えない。src/store/admin-users.ts）
  const role = await roleOf(deps.db, conn.shop_id, sess.user_id);
  if (role !== "owner" && role !== "member") return null;
  // 手代の公開の URL を覚える（配信停止のリンクに使う。Cron には要求の URL が無い）。確かめた券のある要求でだけ
  const origin = new URL(c.req.url).origin;
  if (origin.startsWith("https://")) await setKv(deps.db, SELF_ORIGIN, origin).catch(() => undefined);
  return { s, shopId: conn.shop_id, connection: conn, userId: sess.user_id, role };
}

type Form = Record<string, string | string[]>;

async function readForm(c: C): Promise<Form | null> {
  // 上限つきで読む（券を確かめる前なので、だれでも送れる。src/http-body.ts）
  return readFormLimited(c.req.raw);
}

const one = (f: Form, k: string): string | undefined => {
  const v = f[k];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
};
const many = (f: Form, k: string): string[] => {
  const v = f[k];
  return typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
};

/** POST の共通: Origin と券を確かめる */
async function postSession(c: C): Promise<{ ctx: Ctx; form: Form } | null> {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) return null;
  const form = await readForm(c);
  if (!form) return null;
  const ctx = await sessionFrom(c, one(form, "s"));
  return ctx ? { ctx, form } : null;
}

const back = (c: C, path: string, s: string, msg?: string) => c.redirect(`${path}?s=${encodeURIComponent(s)}${msg ? `&msg=${msg}` : ""}`, 303);

const cleanName = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length >= 1 && t.length <= 100 ? t : null;
};

/** ルールごとの待ち・失敗の数（一覧と編集の画面に出す） */
async function runCounts(c: C, shopId: string): Promise<Record<string, { pending: number; failed: number }>> {
  const rows = await c.env.db.all<{ rule_id: string; status: string; n: number }>(
    `SELECT rule_id, status, COUNT(*) AS n FROM runs WHERE shop_id = ? AND status IN ('pending', 'failed') GROUP BY rule_id, status`,
    [shopId],
  );
  const out: Record<string, { pending: number; failed: number }> = {};
  for (const r of rows) {
    const x = (out[r.rule_id] ??= { pending: 0, failed: 0 });
    if (r.status === "pending") x.pending = r.n;
    else x.failed = r.n;
  }
  return out;
}

async function ruleStats(c: C, shopId: string, ruleId: string) {
  const hits = (await c.env.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits WHERE shop_id = ? AND rule_id = ?`, [shopId, ruleId]))?.n ?? 0;
  const r = (await runCounts(c, shopId))[ruleId] ?? { pending: 0, failed: 0 };
  return { hits, ...r };
}

async function token(c: C, shopId: string): Promise<string | null> {
  return new ConnectionRepo(c.env.db, c.env.config.secret).token(shopId);
}

async function coupons(c: C, shopId: string): Promise<CouponRef[] | null> {
  const tok = await token(c, shopId);
  if (!tok) return null;
  try {
    return await listCoupons(c.env, tok);
  } catch (e) {
    console.error("coupons read failed", e instanceof BantoError ? e.code : "network");
    return null;
  }
}

async function optionNamesOf(c: C, shopId: string): Promise<Record<string, string>> {
  try {
    const raw = await getKv(c.env.db, optionNamesKey(shopId));
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

async function choices(c: C, ctx: Ctx): Promise<ActionChoices> {
  return {
    coupons: await coupons(c, ctx.shopId),
    mailTransport: c.env.config.mail?.transport ?? null,
    slack: !!c.env.config.slackWebhookUrl,
    settings: await getSettings(c.env.db, ctx.shopId),
    shopName: ctx.connection.shop_name,
    optionNames: await optionNamesOf(c, ctx.shopId),
    lastAbandonedAt: Number((await getKv(c.env.db, lastAbandonedKey(ctx.shopId))) ?? "") || null,
  };
}

const ACTION_KEYS = [
  "attr_on",
  "attr_key",
  "attr_value",
  "tags_on",
  "order_tags",
  "coupon_on",
  "coupon_id",
  "message_on",
  "channel",
  "line_text",
  "line_image_url",
  "line_button_label",
  "line_button_url",
  "email_subject",
  "email_body",
  "email_format",
  "slack_on",
  "opmail_on",
  "wait_days",
  "recheck",
];

export function registerAdmin(app: Hono<Env>) {

  // ---------- 注文のお知らせ ----------
  const readiness = async (c: C, ctx: Ctx): Promise<NoticeReadiness> => ({
    mailTransport: !!c.env.config.mail,
    mailFrom: !!(await getSettings(c.env.db, ctx.shopId)).mail_from,
    pii: ctx.connection.scopes.includes("orders:contact") || ctx.connection.scopes.includes("orders:pii"),
  });

  app.get("/admin/notices", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    return page(
      c,
      <NoticesPage
        s={ctx.s}
        templates={await listTemplates(c.env.db, ctx.shopId)}
        ready={await readiness(c, ctx)}
        recent={await recentNotices(c.env.db, ctx.shopId, 50, c.req.query("status") === "failed" ? "failed" : undefined)}
        onlyFailed={c.req.query("status") === "failed"}
        failed={await countFailed(c.env.db, ctx.shopId, c.env.now())}
        msg={c.req.query("msg")}
      />,
    );
  });

  const editPage = async (c: C, ctx: Ctx, t: NoticeTemplate, errors: string[], msg?: string, status: 200 | 400 = 200) =>
    page(
      c,
      <NoticeEditPage
        s={ctx.s}
        template={t}
        settings={await getSettings(c.env.db, ctx.shopId)}
        shopName={ctx.connection.shop_name}
        shopSlug={ctx.connection.shop_slug}
        bantoOrigin={c.env.config.bantoOrigin}
        now={c.env.now()}
        storeRead={ctx.connection.scopes.includes("shop:read")}
        ready={await readiness(c, ctx)}
        errors={errors}
        msg={msg}
      />,
      status,
      { mailPreview: true },
    );

  app.get("/admin/notices/:kind", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const kind = kindParam(c.req.param("kind"));
    if (!kind) return c.notFound();
    return editPage(c, ctx, await getTemplate(c.env.db, ctx.shopId, kind), [], c.req.query("msg"));
  });

  app.post("/admin/notices/save", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const kind = kindParam(one(p.form, "kind"));
    if (!kind) return c.notFound();
    const format = one(p.form, "format") === "html" ? "html" : "text";
    const op = one(p.form, "op");
    const t: NoticeTemplate = {
      kind,
      enabled: !!one(p.form, "enabled"),
      format,
      subject: (one(p.form, "subject") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 150),
      body: (one(p.form, "body") ?? "").replace(/\r\n/g, "\n").trim().slice(0, 5000),
    };
    if (op === "reset") {
      return editPage(c, p.ctx, { ...t, subject: defaultTemplate(kind).subject, body: defaultBody(kind, format) }, [], "reset");
    }
    const errors = checkTemplate(t, format === "html" ? parseMailBody(t.body, slotsFor(kind)).errors : []);
    if (op === "test") {
      // 試し送り: 画面の文面（保存はしない）を見本の注文で作り、設定の「運営者への知らせ」の宛先に 1 通送る
      if (errors.length > 0) return editPage(c, p.ctx, t, errors, undefined, 400);
      const r = await sendTestNotice(c, p.ctx, t);
      return r.ok ? editPage(c, p.ctx, t, [], "notice_test_sent") : editPage(c, p.ctx, t, [r.error], undefined, 400);
    }
    const ready = await readiness(c, p.ctx);
    if (t.enabled && !noticeReady(ready)) errors.push("送る準備がそろっていません（上の「送る前に」）。そろうまで「手代が送る」にはできません");
    if (op !== "save" || errors.length > 0) return editPage(c, p.ctx, t, op === "save" ? errors : errors.filter((e) => !e.startsWith("送る準備")), undefined, op === "save" && errors.length > 0 ? 400 : 200);
    await saveTemplate(c.env.db, p.ctx.shopId, t, c.env.now());
    return back(c, `/admin/notices/${kind}`, p.ctx.s, "saved");
  });

  /** 試し送り。お客様には送らない（宛先は運営者への知らせの宛先だけ）。同じショップは 30 秒に 1 通まで */
  async function sendTestNotice(c: C, ctx: Ctx, t: NoticeTemplate): Promise<{ ok: true } | { ok: false; error: string }> {
    const cfg = c.env.config;
    const settings = await getSettings(c.env.db, ctx.shopId);
    if (!cfg.mail) return { ok: false, error: "メールの送り手がありません（Worker の変数 MAIL_TRANSPORT ほか）" };
    if (!settings.mail_from) return { ok: false, error: "「設定」で送り手のアドレスを入れてください" };
    if (!settings.operator_email) return { ok: false, error: "試し送りは「設定」の「運営者への知らせ」の宛先に送ります。先に入れてください" };
    if (!(await takeSlot(c.env.db, `test_send:${ctx.shopId}`, c.env.now(), TEST_SEND_INTERVAL))) {
      return { ok: false, error: `試し送りは ${TEST_SEND_INTERVAL} 秒に 1 通までです。少し待ってから押してください` };
    }
    const mail = sampleNotice(t, { shopName: ctx.connection.shop_name, shopSlug: ctx.connection.shop_slug, bantoOrigin: cfg.bantoOrigin, settings, now: c.env.now() });
    try {
      await mailer(cfg.mail, { fetch: c.env.fetch, sockets: c.env.sockets, ehloName: new URL(c.req.url).hostname }).send({
        shop: { slug: ctx.connection.shop_slug, id: ctx.connection.shop_id },
        from: settings.mail_from,
        to: settings.operator_email,
        ...(settings.reply_to ? { replyTo: settings.reply_to } : {}),
        ...mail,
        subject: `[試し送り] ${mail.subject}`.slice(0, 200),
      });
    } catch (e) {
      const detail = e instanceof MailError ? e.message : "unknown";
      console.error("notice test send failed", detail.slice(0, 200));
      return { ok: false, error: `送れませんでした（${detail.slice(0, 150)}）。送り手のサービスの設定（確認済みのドメイン・キー）を確かめてください` };
    }
    return { ok: true };
  }

  app.post("/admin/notices/retry-failed", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    await retryFailedNotices(c.env.db, p.ctx.shopId, c.env.now());
    return back(c, "/admin/notices", p.ctx.s, "retried");
  });

  app.post("/admin/notices/retry", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const kind = kindParam(one(p.form, "kind"));
    const orderId = one(p.form, "order_id") ?? "";
    if (kind && ID_RE.test(orderId)) await retryNotice(c.env.db, p.ctx.shopId, orderId, kind, c.env.now());
    return back(c, "/admin/notices", p.ctx.s, "retried");
  });

  // ---------- 設定 ----------
  app.get("/admin/settings", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const cfg = c.env.config;
    // 1 つの手代に複数のショップをつないでいるのに、送り元のドメインをショップごとに決めていない
    const mailWarnings: string[] = [];
    if (cfg.mail) {
      const domains = cfg.mail.fromDomains ?? [];
      const shops = (await c.env.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM connections`))?.n ?? 0;
      if (shops > 1 && !domains.some((d) => d.by === "id")) mailWarnings.push("複数のショップをつないでいます。Worker の変数 MAIL_FROM_DOMAINS に id:<ショップの ID>=ドメイン の形で、ショップごとの送り元のドメインを決めてください（決めないと、ほかのショップの送り元も名乗れます）");
      if (domains.some((d) => d.by === "slug")) mailWarnings.push("MAIL_FROM_DOMAINS に slug: （URL の名前）の決まりがあります。URL の名前は Banto で変えられるので、id:<ショップの ID> の形をお勧めします");
    }
    return page(
      c,
      <SettingsPage
        mailWarnings={mailWarnings}
        users={await listAdminUsers(c.env.db, ctx.shopId)}
        me={ctx.userId}
        isOwner={ctx.role === "owner"}
        s={ctx.s}
        settings={await getSettings(c.env.db, ctx.shopId)}
        errors={[]}
        mailTransport={cfg.mail?.transport ?? null}
        mailProblems={cfg.mailProblems}
        slack={!!cfg.slackWebhookUrl}
        msg={c.req.query("msg")}
      />,
    );
  });

  // この画面を使える人（持ち主だけが許す・外す）
  for (const [path, fn] of [
    ["/admin/users/allow", (db: Deps["db"], shop: string, _me: string, user: string, now: number) => allowUser(db, shop, user, now)],
    ["/admin/users/remove", (db: Deps["db"], shop: string, _me: string, user: string) => removeUser(db, shop, user)],
    ["/admin/users/transfer", (db: Deps["db"], shop: string, me: string, user: string, now: number) => transferOwner(db, shop, me, user, now)],
  ] as const) {
    app.post(path, async (c) => {
      const p = await postSession(c);
      if (!p) return expired(c);
      if (p.ctx.role !== "owner") return back(c, "/admin/settings", p.ctx.s, "owner_only");
      const userId = one(p.form, "user_id") ?? "";
      if (ID_RE.test(userId) && userId !== p.ctx.userId) await fn(c.env.db, p.ctx.shopId, p.ctx.userId, userId, c.env.now());
      return back(c, "/admin/settings", p.ctx.s, "saved");
    });
  }

  app.post("/admin/settings", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const fields: Record<string, string | undefined> = {};
    for (const k of ["mail_from", "reply_to", "sender_name", "sender_address", "sender_contact", "operator_email", "mail_accent", "mail_logo_url", "cap_day", "cap_week", "quiet_start", "quiet_end"]) fields[k] = one(p.form, k);
    const isOwner = p.ctx.role === "owner";
    // 送り手・返信先・運営者への宛先（だれに・どのアドレスから送るか）は持ち主だけが変える
    if (!isOwner) {
      const cur = await getSettings(c.env.db, p.ctx.shopId);
      fields.mail_from = cur.mail_from;
      fields.reply_to = cur.reply_to;
      fields.operator_email = cur.operator_email;
    }
    const r = parseSettingsForm(fields);
    const cfg = c.env.config;
    // 持ち主でない人は送り手を変えられないので、今の送り手が後から許されなくなっていても、ほかの項目の保存は止めない
    if (isOwner && cfg.mail && r.settings.mail_from && !fromAllowed(cfg.mail, r.settings.mail_from, { slug: p.ctx.connection.shop_slug, id: p.ctx.connection.shop_id })) {
      r.errors.push(`送り手のアドレスは、このショップに決めたドメイン（${domainsFor(cfg.mail, { slug: p.ctx.connection.shop_slug, id: p.ctx.connection.shop_id }).join("・") || "なし"}）のものにしてください（Worker の変数 MAIL_FROM_DOMAINS）`);
    }
    if (r.errors.length > 0) {
      return page(c, <SettingsPage s={p.ctx.s} isOwner={isOwner} settings={r.settings} errors={r.errors} mailTransport={cfg.mail?.transport ?? null} mailProblems={cfg.mailProblems} slack={!!cfg.slackWebhookUrl} />, 400);
    }
    await saveSettings(c.env.db, p.ctx.shopId, r.settings, c.env.now());
    return back(c, "/admin/settings", p.ctx.s, "saved");
  });

  app.post("/admin/settings/test-mail", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const cfg = c.env.config;
    const st = await getSettings(c.env.db, p.ctx.shopId);
    const fail = (msg: string) =>
      page(c, <SettingsPage s={p.ctx.s} isOwner={p.ctx.role === "owner"} settings={st} errors={[msg]} mailTransport={cfg.mail?.transport ?? null} mailProblems={cfg.mailProblems} slack={!!cfg.slackWebhookUrl} />, 400);
    if (!cfg.mail || !st.mail_from || !st.operator_email) return fail("メールの送り手（Worker の変数）・送り手のアドレス・運営者の宛先をそろえてから押してください");
    // 注文のお知らせの試し送りと同じ上限（ショップごとに 30 秒に 1 通）
    if (!(await takeSlot(c.env.db, `test_send:${p.ctx.shopId}`, c.env.now(), TEST_SEND_INTERVAL))) return fail(`試し送りは ${TEST_SEND_INTERVAL} 秒に 1 通までです。少し待ってから押してください`);
    try {
      await mailer(cfg.mail, { fetch: c.env.fetch, sockets: c.env.sockets, ehloName: new URL(c.req.url).hostname }).send({
        shop: { slug: p.ctx.connection.shop_slug, id: p.ctx.connection.shop_id },
        from: st.mail_from,
        to: st.operator_email,
        ...(st.reply_to ? { replyTo: st.reply_to } : {}),
        subject: `[手代] 試しのメール（${p.ctx.connection.shop_name}）`,
        text: `手代から試しに送ったメールです。\nこのメールが届いていれば、送り手（${cfg.mail.transport}）と送り手のアドレス（${st.mail_from}）でメールを送れます。\n\nお客様への案内メールは、同意のある会員だけに、送り手の表示と配信停止のリンクを付けて送ります。`,
      });
    } catch (e) {
      const why = e instanceof MailError ? e.message : e instanceof Error ? e.message : "unknown";
      return fail(`試しに送れませんでした: ${why.slice(0, 300)}`);
    }
    return back(c, "/admin/settings", p.ctx.s, "test_sent");
  });

  // ---------- 商品の集まり ----------
  app.get("/admin/sets", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    return page(c, <SetsPage s={ctx.s} sets={await listSets(c.env.db, ctx.shopId)} msg={c.req.query("msg")} query={(c.req.query("q") ?? "").slice(0, 100)} />);
  });

  app.post("/admin/sets", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const name = cleanName(one(p.form, "name"));
    if (!name) return back(c, "/admin/sets", p.ctx.s, "name_required");
    const id = await createSet(c.env.db, p.ctx.shopId, name, c.env.now());
    if (id === "too_many") return back(c, "/admin/sets", p.ctx.s, "too_many");
    return back(c, `/admin/sets/${id}`, p.ctx.s);
  });

  app.get("/admin/sets/:id", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const found = await getSet(c.env.db, ctx.shopId, c.req.param("id"));
    if (!found) return c.notFound();
    const query = (c.req.query("q") ?? "").trim().slice(0, 100);
    const tok = await token(c, ctx.shopId);
    let results: ProductRef[] | null = null;
    let categories = null;
    let msg = c.req.query("msg");
    try {
      if (tok && c.req.query("q") !== undefined) results = (await searchProducts(c.env, tok, query)).items;
      if (tok) categories = await listCategories(c.env, tok);
    } catch (e) {
      console.error("catalog read failed", e instanceof BantoError ? e.code : "network");
      msg = "banto_error";
    }
    return page(c, <SetEditPage s={ctx.s} set={found.set} items={found.items} query={query} results={results} categories={categories} msg={msg} />);
  });

  app.post("/admin/sets/:id", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const { ctx, form } = p;
    const db = c.env.db;
    const id = c.req.param("id");
    const path = `/admin/sets/${id}`;
    if (!(await getSet(db, ctx.shopId, id))) return c.notFound();
    const now = c.env.now();
    switch (one(form, "op")) {
      case "rename": {
        const name = cleanName(one(form, "name"));
        if (!name) return back(c, path, ctx.s, "name_required");
        await renameSet(db, ctx.shopId, id, name, now);
        return back(c, path, ctx.s, "saved");
      }
      case "remove": {
        const ids = many(form, "product_id").filter((x) => ID_RE.test(x)).slice(0, 200);
        if (ids.length === 0) return back(c, path, ctx.s, "none_selected");
        await removeSetItems(db, ctx.shopId, id, ids, now);
        return back(c, path, ctx.s, "removed");
      }
      case "add": {
        const items: SetItem[] = [];
        for (const raw of many(form, "product").slice(0, 100)) {
          try {
            const v = JSON.parse(raw) as Record<string, unknown>;
            if (typeof v["id"] === "string" && ID_RE.test(v["id"]) && typeof v["name"] === "string" && typeof v["slug"] === "string") {
              items.push({ product_id: v["id"], product_name: v["name"], product_slug: v["slug"] });
            }
          } catch {
            // 形の違う値は飛ばす
          }
        }
        if (items.length === 0) return back(c, path, ctx.s, "none_selected");
        const added = await addSetItems(db, ctx.shopId, id, items, now);
        return back(c, path, ctx.s, added < items.length ? "full" : "added");
      }
      case "add_category": {
        const catId = one(form, "category_id") ?? "";
        const tok = await token(c, ctx.shopId);
        if (!tok || !ID_RE.test(catId)) return back(c, path, ctx.s, "banto_error");
        try {
          const cats = await listCategories(c.env, tok);
          const r = await productsInCategory(c.env, tok, withDescendants(cats, catId));
          const items = r.items.map((x) => ({ product_id: x.id, product_name: x.name, product_slug: x.slug }));
          const added = await addSetItems(db, ctx.shopId, id, items, now);
          return back(c, path, ctx.s, added < items.length ? "full" : r.truncated ? "truncated" : "added");
        } catch (e) {
          console.error("category read failed", e instanceof BantoError ? e.code : "network");
          return back(c, path, ctx.s, "banto_error");
        }
      }
      case "delete": {
        const r = await deleteSet(db, ctx.shopId, id);
        return r === "in_use" ? back(c, path, ctx.s, "in_use") : back(c, "/admin/sets", ctx.s, "deleted");
      }
      default:
        return c.text("bad request", 400);
    }
  });

  // ---------- ルール ----------
  app.get("/admin/rules", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const db = c.env.db;
    const counts = await db.all<{ rule_id: string; n: number }>(`SELECT rule_id, COUNT(*) AS n FROM rule_hits WHERE shop_id = ? GROUP BY rule_id`, [ctx.shopId]);
    return page(
      c,
      <RulesPage
        s={ctx.s}
        rules={await listRules(db, ctx.shopId)}
        sets={await listSets(db, ctx.shopId)}
        hits={Object.fromEntries(counts.map((x) => [x.rule_id, x.n]))}
        coupons={(await coupons(c, ctx.shopId)) ?? []}
        runs={await runCounts(c, ctx.shopId)}
        optionNames={await optionNamesOf(c, ctx.shopId)}
        msg={c.req.query("msg")}
        query={(c.req.query("q") ?? "").slice(0, 100)}
      />,
    );
  });

  app.get("/admin/rules/new", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const form: RuleForm = { id: null, name: "", status: "draft", fields: { trigger: "order.paid", exclude_bought: "1", purchase_on: "1", mode: "all_in_one_order", wait_days: "0", recheck: "1" } };
    return page(c, <RuleEditPage s={ctx.s} form={form} sets={await listSets(c.env.db, ctx.shopId)} errors={[]} preview={null} choices={await choices(c, ctx)} />, 200, { mailPreview: true });
  });

  app.get("/admin/rules/:id", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const r = await getRule(c.env.db, ctx.shopId, c.req.param("id"));
    if (!r) return c.notFound();
    return page(
      c,
      <RuleEditPage
        s={ctx.s}
        form={ruleToForm(r)}
        sets={await listSets(c.env.db, ctx.shopId)}
        errors={[]}
        preview={null}
        choices={await choices(c, ctx)}
        stats={await ruleStats(c, ctx.shopId, r.id)}
        msg={c.req.query("msg")}
      />,
      200,
      { mailPreview: true },
    );
  });

  app.post("/admin/rules/save", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    const { ctx, form } = p;
    const db = c.env.db;
    const sets = await listSets(db, ctx.shopId);
    const rawId = one(form, "id");
    const id = rawId && ID_RE.test(rawId) && (await getRule(db, ctx.shopId, rawId)) ? rawId : null;
    const fields: Record<string, string | undefined> = {};
    for (const k of ["trigger", "trigger_days", "exclude_bought", "purchase_on", "set_id", "mode", "n", "purchase_days", "orders_on", "orders_n", "orders_days", "spend_on", "spend_yen", "spend_days", ...ACTION_KEYS])
      fields[k] = one(form, k);
    fields["variant_unit"] = one(form, "variant_unit");
    fields["variant_axes"] = many(form, "variant_axes").join(",");
    const status = one(form, "status") ?? "draft";
    const rf: RuleForm = { id, name: (one(form, "name") ?? "").slice(0, 100), status, fields };
    const errors: string[] = [];
    const name = cleanName(rf.name);
    if (!name) errors.push("名前を入れてください（100 文字まで）");
    if (!isRuleStatus(status)) errors.push("状態を選んでください");
    const trig = parseTriggerForm(fields);
    errors.push(...trig.errors);
    const parsed = parseConditionForm(fields, new Set(sets.map((x) => x.id)), { allowEmpty: trig.trigger.kind !== "order.paid" });
    if (!parsed.ok) errors.push(...parsed.errors);
    const ch = await choices(c, ctx);
    const acts = parseActionsForm(fields, {
      productTrigger: hasProduct(trig.trigger.kind),
      mailTransport: !!c.env.config.mail,
      mailSettings: mailReady(ch.settings),
      operatorEmail: !!ch.settings.operator_email,
      slack: !!c.env.config.slackWebhookUrl,
    });
    errors.push(...acts.errors);
    if (status === "active" && !hasAny(acts.actions)) errors.push("「動かす」には、アクションを 1 つ以上選んでください");
    const op = one(form, "op");
    if (op === "preview" && parsed.ok && trig.errors.length === 0) {
      const t = trig.trigger;
      const pv = t.kind === "checkout_abandoned"
        ? await previewCustomers(db, parsed.condition, ctx.shopId, c.env.now())
        : isFavoriteTrigger(t.kind)
        ? await previewFavorites(db, parsed.condition, ctx.shopId, c.env.now())
        : isTimeTrigger(t.kind) && t.days
          ? await previewTime(db, t.kind as "last_order" | "first_order", t.days, parsed.condition, ctx.shopId, c.env.now())
          : await preview(db, parsed.condition, ctx.shopId, c.env.now());
      const people = await loadPeople(c.env, await token(c, ctx.shopId), pv.sample);
      return page(c, <RuleEditPage s={ctx.s} form={rf} sets={sets} errors={errors} preview={{ ...pv, condition: parsed.condition, people }} choices={ch} />, 200, { mailPreview: true });
    }
    if (errors.length === 0 && isRuleStatus(status) && parsed.ok && name) {
      if (RUNNING_STATUSES.includes(status)) {
        const running = (await listRules(db, ctx.shopId, RUNNING_STATUSES)).filter((r) => r.id !== id).length;
        if (running >= MAX_RUNNING_RULES) errors.push(`動かせるルールは ${MAX_RUNNING_RULES} 個までです。ほかのルールを止めてください`);
      }
      if (errors.length === 0) {
        const saved = await saveRule(db, ctx.shopId, { id, name, status, condition: parsed.condition, actions: acts.actions, trigger: trig.trigger }, c.env.now());
        if (saved === "too_many") return back(c, "/admin/rules", ctx.s, "too_many");
        return back(c, `/admin/rules/${saved}`, ctx.s, "saved");
      }
    }
    return page(c, <RuleEditPage s={ctx.s} form={rf} sets={sets} errors={errors} preview={null} choices={ch} />, 400, { mailPreview: true });
  });

  app.post("/admin/rules/:id/delete", async (c) => {
    const p = await postSession(c);
    if (!p) return expired(c);
    await deleteRule(c.env.db, p.ctx.shopId, c.req.param("id"));
    return back(c, "/admin/rules", p.ctx.s, "deleted");
  });

  app.get("/admin/rules/:id/hits", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const r = await getRule(c.env.db, ctx.shopId, c.req.param("id"));
    if (!r) return c.notFound();
    const h = await listHits(c.env.db, ctx.shopId, r.id);
    const people = await loadPeople(c.env, await token(c, ctx.shopId), h.items.map((x) => x.customer_id), 20);
    return page(c, <HitsPage s={ctx.s} rule={r} total={h.total} items={h.items} people={people} />);
  });

  app.get("/admin/rules/:id/check", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const r = await getRule(c.env.db, ctx.shopId, c.req.param("id"));
    if (!r) return c.notFound();
    const customer = (c.req.query("customer") ?? "").trim();
    if (!customer) return page(c, <CheckPage s={ctx.s} rule={r} customerId="" result={null} />);
    if (!ID_RE.test(customer)) return page(c, <CheckPage s={ctx.s} rule={r} customerId={customer.slice(0, 100)} result={null} error="会員 ID の形が違います" />, 400);
    const people = await loadPeople(c.env, await token(c, ctx.shopId), [customer], 1);
    return page(c, <CheckPage s={ctx.s} rule={r} customerId={customer} result={await explain(c.env.db, r, ctx.shopId, customer, c.env.now())} people={people} />);
  });

  app.get("/admin/rules/:id/runs", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const db = c.env.db;
    const r = await getRule(db, ctx.shopId, c.req.param("id"));
    if (!r) return c.notFound();
    const total = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE shop_id = ? AND rule_id = ?`, [ctx.shopId, r.id]))?.n ?? 0;
    const rows = await db.all<{ customer_id: string; order_id: string | null; status: string; steps: string; attempts: number; last_error: string | null; updated_at: number; due_at: number }>(
      `SELECT customer_id, order_id, status, steps, attempts, last_error, updated_at, due_at FROM runs WHERE shop_id = ? AND rule_id = ? ORDER BY updated_at DESC LIMIT 100`,
      [ctx.shopId, r.id],
    );
    const items = rows.map((x) => {
      let steps: Steps = {};
      try {
        steps = JSON.parse(x.steps) as Steps;
      } catch {
        steps = {};
      }
      return { ...x, summary: messageSummary(steps) };
    });
    const people = await loadPeople(c.env, await token(c, ctx.shopId), items.map((x) => x.customer_id), 20);
    return page(c, <RunsPage s={ctx.s} rule={r} total={total} items={items} people={people} />);
  });

  app.get("/admin/runs", async (c) => {
    const ctx = await sessionFrom(c, c.req.query("s"));
    if (!ctx) return expired(c);
    const db = c.env.db;
    const status = ["pending", "failed", "done", "skipped"].includes(c.req.query("status") ?? "") ? (c.req.query("status") as string) : "";
    const rules = await listRules(db, ctx.shopId);
    const ruleId = rules.some((r) => r.id === c.req.query("rule")) ? (c.req.query("rule") as string) : "";
    const where = `ru.shop_id = ?${status ? " AND ru.status = ?" : ""}${ruleId ? " AND ru.rule_id = ?" : ""}`;
    const params = [ctx.shopId, ...(status ? [status] : []), ...(ruleId ? [ruleId] : [])];
    const total = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM runs ru WHERE ${where}`, params))?.n ?? 0;
    const rows = await db.all<{ rule_id: string; rule_name: string; customer_id: string; order_id: string | null; status: string; steps: string; attempts: number; last_error: string | null; updated_at: number; due_at: number }>(
      `SELECT ru.rule_id, r.name AS rule_name, ru.customer_id, ru.order_id, ru.status, ru.steps, ru.attempts, ru.last_error, ru.updated_at, ru.due_at
       FROM runs ru JOIN rules r ON r.shop_id = ru.shop_id AND r.id = ru.rule_id WHERE ${where} ORDER BY ru.updated_at DESC LIMIT 100`,
      params,
    );
    const counts = Object.fromEntries(
      (await db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM runs WHERE shop_id = ? GROUP BY status`, [ctx.shopId])).map((x) => [x.status, x.n]),
    );
    const items = rows.map((x) => {
      let steps: Steps = {};
      try {
        steps = JSON.parse(x.steps) as Steps;
      } catch {
        steps = {};
      }
      return { ...x, summary: messageSummary(steps) };
    });
    const people = await loadPeople(c.env, await token(c, ctx.shopId), items.map((x) => x.customer_id), 20);
    return page(c, <AllRunsPage s={ctx.s} rules={rules} status={status} ruleId={ruleId} total={total} items={items} people={people} counts={counts} />);
  });
}
