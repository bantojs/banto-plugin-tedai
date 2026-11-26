/** @jsxImportSource hono/jsx */
/**
 * 手代の本体（ランタイムに依存しない）。入口（Workers: src/index.ts）が Deps を組み立てて `app.fetch(req, deps)` で呼ぶ。
 *
 *   GET  /         マニフェスト（Accept: application/json）か、案内の画面
 *   POST /         Banto の hooks の受け口（署名・配信 ID で冪等）
 *   GET  /connect  「つなぐ」の券を受け、Banto と裏で引き換える
 *   GET  /admin    Banto の管理画面の iframe（banto_ticket を確かめる）
 */
import { Hono } from "hono";
import { exchangeTicket, BantoError } from "./banto/client";
import { verifyHookSignature, verifyPluginTicket } from "./banto/signing";
import { signSession, verifySession } from "./admin/session";
import { Dashboard, Landing, Message } from "./admin/views";
import { handleEvent, isHandled, type Envelope } from "./events";
import { processNotices } from "./notices/send";
import { manifest } from "./manifest";
import { ConnectionRepo } from "./store/connections";
import { forgetDelivery, recordDelivery } from "./store/deliveries";
import { ensureMigrated } from "./store/migrations";
import { clearRevoked } from "./store/purge";
import { dashboardData } from "./admin/dashboard";
import { readUnsubscribeToken } from "./unsubscribe";
import { withdrawConsent } from "./banto/members";
import { setKv, SELF_ORIGIN, takeSlot } from "./store/settings";
import { readForm, readLimited, readSmallForm } from "./http-body";

import { expired, MAIL_PREVIEW_HEADER, page, type C, type Env } from "./admin/http";
import { registerAdmin } from "./admin/routes";
import { admit, claimOpen, claimWithCode, hasOwner, formatClaimCode, resetAdminUsers, roleOf, shortUser } from "./store/admin-users";

const MAX_HOOK_BODY = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function createApp() {
  const app = new Hono<Env>();

  // 画面の共通のヘッダ。iframe に入れてよいのはつないだ Banto だけ
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    // same-origin: 手代の外（Banto・お客様のリンク）へは参照元を送らない。no-referrer にすると、
    // ブラウザは自分の画面からのフォームの POST にも Origin: null を付けるので、Origin の確かめで断ってしまう（2026-11-09 実機で踏んだ）
    c.header("Referrer-Policy", "same-origin");
    const mailPreview = c.res.headers.get(MAIL_PREVIEW_HEADER) === "1";
    c.res.headers.delete(MAIL_PREVIEW_HEADER);
    if ((c.res.headers.get("Content-Type") ?? "").startsWith("text/html")) {
      c.header("Cache-Control", "no-store");
      // メールの見本を載せる画面だけ img-src に https: を足す（sandbox の srcdoc は親の CSP を受け継ぐので、ロゴと本文の画像を出すため）。
      // 画像の先の URL は運営者が自分で書いたものだけ（お客様の値は画像の先にならない。src/mail/html.ts）
      const img = mailPreview ? "'self' https:" : "'self'";
      c.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; form-action 'self'; base-uri 'none'; frame-ancestors ${c.env.config.bantoOrigin}`);
    }
  });

  app.get("/", (c) => {
    const origin = new URL(c.req.url).origin;
    if ((c.req.header("Accept") ?? "").includes("application/json")) return c.json(manifest(origin));
    return page(c, <Landing missing={[]} hookUrl={`${origin}/`} />);
  });

  app.post("/", async (c) => receiveHook(c));

  app.get("/connect", async (c) => {
    const ticket = c.req.query("ticket") ?? "";
    const bantoParam = c.req.query("banto") ?? "";
    const deps = c.env;
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) {
      return page(c, <Message title="つなげませんでした" tone="bad"><p>券の形が違います。Banto の連携の画面からやり直してください。</p></Message>, 400);
    }
    // よその Banto からの券は引き換えない（手代は変数 BANTO_URL の Banto だけとつなぐ）
    let fromOrigin = "";
    try {
      fromOrigin = new URL(bantoParam).origin;
    } catch {
      fromOrigin = "";
    }
    if (fromOrigin && fromOrigin !== deps.config.bantoOrigin) {
      return page(c, 
        <Message title="つなげませんでした" tone="bad">
          <p>この手代は {deps.config.bantoOrigin} とつなぐ設定です。別の Banto（{fromOrigin}）とはつなぎません。</p>
          <p class="muted">別の Banto で使うときは、その Banto 用に手代をもう 1 つ置いてください。</p>
        </Message>,
        400,
      );
    }
    try {
      await ensureMigrated(deps.db);
      const r = await exchangeTicket(deps, ticket);
      await new ConnectionRepo(deps.db, deps.config.secret).save(
        {
          shop_id: r.shop.id,
          endpoint_id: r.endpoint_id,
          shop_slug: r.shop.slug,
          shop_name: r.shop.name,
          scopes: r.scopes,
          banto_version: r.banto_version,
          connected_by: null,
          token: r.token,
          signing_secret: r.signing_secret,
        },
        deps.now(),
      );
      // 持ち主がまだいなければ、持ち主になるための 1 回限りのコードを出す。もういれば持ち主・使える人はそのまま
      // （「連携」の項目があればだれでもつなぎ直せるので、つなぎ直しで持ち主を変えない。src/store/admin-users.ts）
      const claimCode = await resetAdminUsers(deps.db, r.shop.id, deps.now());
      // 前のトークンが断られていた印を消す（突き合わせを今の回からまた行う）
      await deps.db.batch([
        { sql: `UPDATE order_sync SET last_error = NULL WHERE shop_id = ?`, params: [r.shop.id] },
        { sql: `UPDATE favorite_sync SET last_error = NULL WHERE shop_id = ?`, params: [r.shop.id] },
        clearRevoked(r.shop.id),
      ]);
      await setKv(deps.db, SELF_ORIGIN, new URL(c.req.url).origin);
      return page(c, 
        <Message title="つなぎました" tone="ok">
          {claimCode ? (
            <>
              <p>
                手代は「{r.shop.name}」とつながりました。Banto の管理画面 → 連携 に戻り、手代の画面を開いて、次の<strong>持ち主のコード</strong>を入れてください。コードを入れた人が、この画面の持ち主になります（ほかの人は持ち主が許すと使えます）。
              </p>
              <p style="font-size:1.5rem;letter-spacing:.15em">
                <code>{formatClaimCode(claimCode)}</code>
              </p>
              <p class="muted small">このコードはこの画面にだけ出ます（手代は覚えていません）。24 時間で使えなくなり、そのときはつなぎ直すと新しいコードが出ます。ほかの人に見せないでください。</p>
            </>
          ) : (
            <p>
              手代は「{r.shop.name}」とつなぎ直しました。手代の画面の持ち主と、持ち主が許した人は前のままです（つなぎ直しでは持ち主は変わりません）。
            </p>
          )}
          <p>
            <a href={`${deps.config.bantoOrigin}/admin`} target="_top">
              Banto の管理画面へ
            </a>
          </p>
        </Message>,
      );
    } catch (e) {
      const code = e instanceof BantoError ? e.code : "network";
      console.error("connect failed", code);
      const text =
        code === "invalid_ticket"
          ? "券の期限（2 分）が切れたか、もう使われています。Banto の連携の画面から「つなぎ直す」を押してください。"
          : code === "scope_not_permitted"
            ? "許した人の権限が足りません。権限を持つ人がつなぎ直してください。"
            : "Banto と引き換えられませんでした。少し待ってからやり直してください。";
      return page(c, <Message title="つなげませんでした" tone="bad"><p>{text}</p><p class="muted">理由: {code}</p></Message>, 400);
    }
  });

  app.get("/admin", async (c) => {
    const deps = c.env;
    await ensureMigrated(deps.db);
    const repo = new ConnectionRepo(deps.db, deps.config.secret);
    const now = deps.now();
    const s = c.req.query("s");
    if (s) {
      const sess = await verifySession(deps.config.secret, s, now);
      const conn = sess ? await repo.get(sess.shop_id) : null;
      if (!sess || !conn || conn.endpoint_id !== sess.endpoint_id) return expired(c);
      const role = await roleOf(deps.db, sess.shop_id, sess.user_id);
      if (role !== "owner" && role !== "member") return expired(c);
      return page(c, <Dashboard s={s} {...await dashboardData(deps, conn)} />);
    }
    const ticket = c.req.query("banto_ticket") ?? "";
    const shopId = c.req.query("shop_id") ?? "";
    if (!ticket || !ID_RE.test(shopId)) return expired(c);
    const found = await repo.signingSecret(shopId);
    if (!found) {
      return page(c, 
        <Message title="まだつながっていません" tone="bad">
          <p>Banto の連携の画面で「つなぐ」を押してください（受け口の URL を登録しただけでは、手代は Banto を読めません）。</p>
        </Message>,
      );
    }
    const t = await verifyPluginTicket(found.secret, ticket, now);
    if (!t || t.shop_id !== shopId || t.endpoint_id !== found.connection.endpoint_id) return expired(c);
    // 画面を使えるのは持ち主（つないだときのコードを入れた人）と、持ち主が許した人だけ（src/store/admin-users.ts）
    const role = await admit(deps.db, t.shop_id, t.user_id, now);
    if (role === "unclaimed") return claimPage(c, ticket, shopId, await claimOpen(deps.db, shopId, now));
    if (role === "pending") {
      return page(
        c,
        <Message title="この画面を使う許しがありません" tone="bad">
          <p>
            手代の画面は、手代をつないだ人（持ち主）と、その人が許した人だけが使えます。持ち主に、手代の「設定」→「この画面を使える人」で、あなた（ID <code>{shortUser(t.user_id)}</code>）を許してもらってください。
          </p>
          <p class="muted small">持ち主が分からないときは、ショップの権限を持つ人が Banto の連携の画面で手代をつなぎ直し、出たコードで持ち主になってください。</p>
        </Message>,
        403,
      );
    }
    const session = await signSession(deps.config.secret, { shop_id: t.shop_id, endpoint_id: t.endpoint_id, user_id: t.user_id }, now);
    // 券を URL から外す（履歴に残さない）。以後は手代の作業の券で運ぶ
    return c.redirect(`/admin?s=${encodeURIComponent(session)}`, 303);
  });

  // 持ち主になる（つないだときのコードを入れる）。券（5 分）をもう一度確かめる
  app.post("/admin/claim", async (c) => {
    const deps = c.env;
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) return expired(c);
    await ensureMigrated(deps.db);
    const f = await readForm(c.req.raw);
    if (!f) return c.text("too large", 413);
    const first = (k: string) => {
      const v = f[k];
      return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
    };
    const ticket = first("banto_ticket");
    const shopId = first("shop_id");
    const code = first("code").slice(0, 40);
    if (!ticket || !ID_RE.test(shopId)) return expired(c);
    const repo = new ConnectionRepo(deps.db, deps.config.secret);
    const found = await repo.signingSecret(shopId);
    const now = deps.now();
    const t = found ? await verifyPluginTicket(found.secret, ticket, now) : null;
    if (!found || !t || t.shop_id !== shopId || t.endpoint_id !== found.connection.endpoint_id) return expired(c);
    if (await hasOwner(deps.db, shopId)) {
      return page(c, <Message title="もう持ち主がいます" tone="bad"><p>この手代にはもう持ち主がいます。使うには、持ち主に「設定」→「この画面を使える人」で許してもらってください。</p></Message>, 403);
    }
    // 総当たりを遅くする（ショップごとに 3 秒に 1 回）
    if (!(await takeSlot(deps.db, `owner_claim_try:${shopId}`, now, 3))) return claimPage(c, ticket, shopId, true, "少し待ってからもう一度入れてください");
    if (!(await claimWithCode(deps.db, shopId, t.user_id, code, now))) {
      return claimPage(c, ticket, shopId, await claimOpen(deps.db, shopId, now), "コードが違うか、もう使われています");
    }
    const session = await signSession(deps.config.secret, { shop_id: t.shop_id, endpoint_id: t.endpoint_id, user_id: t.user_id }, now);
    return c.redirect(`/admin?s=${encodeURIComponent(session)}`, 303);
  });

  // 配信停止（メールのリンクと、RFC 8058 のワンクリック）。GET は確かめる画面だけ（リンクを読むだけの仕組みで止まらないように）
  app.get("/u/:token", async (c) => {
    const t = await readUnsubscribeToken(c.env.config.secret, c.req.param("token"));
    if (!t) return page(c, <Message title="リンクが正しくありません" tone="bad"><p>メールのリンクをもう一度開いてください。</p></Message>, 400);
    await ensureMigrated(c.env.db);
    const conn = await new ConnectionRepo(c.env.db, c.env.config.secret).get(t.shopId);
    return page(
      c,
      <Message title="お知らせの配信を止めますか" tone="ok">
        <p>{conn ? `「${conn.shop_name}」からの` : ""}お知らせのメールを止めます。注文の確認など、お取引のメールは届きます。</p>
        <form method="post" action={`/u/${c.req.param("token")}`}>
          <input type="hidden" name="confirm" value="1" />
          <button class="primary">配信を止める</button>
        </form>
      </Message>,
    );
  });

  app.post("/u/:token", async (c) => {
    const deps = c.env;
    const t = await readUnsubscribeToken(deps.config.secret, c.req.param("token"));
    if (!t) return c.text("bad token", 400);
    const form = await readSmallForm(c.req.raw);
    if (!form) return c.text("too large", 413);
    const oneClick = form["List-Unsubscribe"] === "One-Click";
    if (!oneClick && form["confirm"] !== "1") return c.text("bad request", 400);
    await ensureMigrated(deps.db);
    const tok = await new ConnectionRepo(deps.db, deps.config.secret).token(t.shopId);
    if (!tok) {
      // 手代と Banto のつながりが切れていて、同意を取り下げられない。止めたと言わない
      console.error("unsubscribe: shop not connected");
      if (oneClick) return c.text("unavailable", 503);
      return page(c, <Message title="止められませんでした" tone="bad"><p>いまは配信を止められません。お手数ですが、メールの最後にある問い合わせ先へご連絡ください。</p></Message>, 503);
    }
    try {
      await withdrawConsent(deps, tok, t.customerId);
    } catch (e) {
      // 会員がもういない（404）なら止まっているのと同じ
      if (!(e instanceof BantoError && e.status === 404)) {
        console.error("unsubscribe failed", e instanceof BantoError ? e.code : "network");
        if (oneClick) return c.text("try again", 503);
        return page(c, <Message title="止められませんでした" tone="bad"><p>少し待ってから、もう一度押してください。</p></Message>, 503);
      }
    }
    if (oneClick) return c.text("ok", 200);
    return page(c, <Message title="配信を止めました" tone="ok"><p>これから、お知らせのメールは届きません。</p></Message>);
  });

  registerAdmin(app);

  // 思いがけない失敗（D1 が一時的に落ちた など）も、画面で知らせる（英語の 500 の文字だけにしない）。保存は行われていない
  app.onError((e, c) => {
    console.error("unhandled", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    if (c.req.method === "POST" && c.req.path === "/") return c.text("failed", 500);
    return page(
      c,
      <Message title="うまく行きませんでした" tone="bad">
        <p>手代の中で思いがけない失敗がありました。{c.req.method === "POST" ? "いまの保存・操作は最後まで行われていません。開き直して、保存されているか確かめてください。" : ""}少し待ってから、もう一度お試しください。</p>
        <p class="muted small">続くときは、Cloudflare の画面で手代の Worker のログを見てください。</p>
      </Message>,
      500,
    );
  });
  return app;
}

/** 持ち主がまだいないショップの画面: つないだときのコードを入れてもらう（無い・切れたら、つなぎ直しを案内する） */
function claimPage(c: C, ticket: string, shopId: string, open: boolean, error?: string) {
  if (!open) {
    return page(
      c,
      <Message title="持ち主がまだ決まっていません" tone="bad">
        <p>
          手代の画面は、手代をつないだ人（持ち主）と、その人が許した人だけが使えます。持ち主を決めるには、ショップの権限を持つ人が Banto の管理画面 → 連携 → 手代 で<strong>つなぎ直し</strong>、そのときに出る持ち主のコードを、ここで入れてください。
        </p>
      </Message>,
      403,
    );
  }
  return page(
    c,
    <Message title="持ち主のコードを入れてください" tone="ok">
      <p>手代をつないだときに「つなぎました」の画面に出たコードを入れると、あなたがこの画面の持ち主になります。</p>
      {error ? <p class="bad">{error}</p> : null}
      <form method="post" action="/admin/claim">
        <input type="hidden" name="banto_ticket" value={ticket} />
        <input type="hidden" name="shop_id" value={shopId} />
        <label for="code">持ち主のコード</label>
        <input type="text" id="code" name="code" autocomplete="off" maxlength={20} placeholder="XXXXX-XXXXX" />
        <p>
          <button>持ち主になる</button>
        </p>
      </form>
      <p class="muted small">コードが分からないときは、つなぎ直すと新しいコードが出ます。</p>
    </Message>,
    error ? 400 : 200,
  );
}

async function receiveHook(c: C): Promise<Response> {
  const deps = c.env;
  const len = Number(c.req.header("Content-Length") ?? "0");
  if (len > MAX_HOOK_BODY) return c.text("too large", 413);
  // Content-Length の無い送り方でも、上限を越えたらそこで読むのをやめる（署名を確かめる前なので、だれでも送れる）
  const body = await readLimited(c.req.raw, MAX_HOOK_BODY);
  if (body === null) return c.text("too large", 413);
  let env: Envelope;
  try {
    env = JSON.parse(body) as Envelope;
  } catch {
    return c.text("bad json", 400);
  }
  if (!env || typeof env !== "object" || typeof env.id !== "string" || !ID_RE.test(env.id) || typeof env.event !== "string" || typeof env.shop_id !== "string" || !ID_RE.test(env.shop_id)) {
    return c.text("bad envelope", 400);
  }
  await ensureMigrated(deps.db);
  const found = await new ConnectionRepo(deps.db, deps.config.secret).signingSecret(env.shop_id);
  // つなぐ前（Banto がサイトの秘密から作った署名）・つないでいないショップ・TEDAI_SECRET が変わった、はここで断る。
  // 401 なら Banto は再送し、つないだ後の再送は通る
  if (!found) return c.text("not connected", 401);
  if (!(await verifyHookSignature(found.secret, body, c.req.header("X-Banto-Signature") ?? null, deps.now()))) return c.text("bad signature", 401);
  if (!env.data || typeof env.data !== "object") env.data = {};
  if (!(await isHandled(deps, env.shop_id, env.event))) return c.text("ok", 200);
  const first = await recordDelivery(deps.db, { id: env.id, shop_id: env.shop_id, event: env.event.slice(0, 100) }, deps.now());
  if (!first) return c.text("duplicate", 200);
  try {
    await handleEvent(deps, found.connection, env);
  } catch (e) {
    // 受け取っていないことにして、Banto に送り直してもらう
    await forgetDelivery(deps.db, env.shop_id, env.id);
    console.error("event failed", env.event, e instanceof Error ? e.message : "unknown");
    return c.text("failed", 500);
  }
  // 注文・お店で試着の知らせは応答の後すぐに送る（Banto の hooks も 5 分ごとなので、Cron を待つとさらに最大 5 分遅れる）。送れなければ Cron がやり直す
  // SMTP は 1 通に 60 秒まで待つので、応答の後の 30 秒に収まらないことがある。Cron（持ち時間が長い）に任せる
  if ((env.event.startsWith("order.") || env.event.startsWith("tryon.") || env.event === "checkout.payment_pending") && deps.config.mail?.transport !== "smtp") {
    const shopId = env.shop_id;
    try {
      c.executionCtx.waitUntil(processNotices(deps, 2, { shopId }).catch((e: unknown) => console.error("notice send failed", e instanceof Error ? e.message.slice(0, 200) : "unknown")));
    } catch {
      // executionCtx の無い実行（テスト・Node）は Cron に任せる
    }
  }
  return c.text("ok", 200);
}

/** 変数が足りないときの応答（マニフェストも返さない。つなげない状態で Banto に登録させない） */
export function notConfigured(req: Request, missing: string[]): Response {
  const origin = new URL(req.url).origin;
  const html = "<!doctype html>" + String(<Landing missing={missing} hookUrl={`${origin}/`} />);
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}
