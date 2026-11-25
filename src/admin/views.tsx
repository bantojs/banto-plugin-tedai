/** @jsxImportSource hono/jsx */
/**
 * 手代の画面の土台（サーバーで描く。スクリプトなし）。文字は hono/jsx がエスケープする。
 * 見た目は Banto の管理画面（src/routes/admin/layout.tsx）の色と部品にそろえる。手代は Banto の管理画面の iframe の中に出るので、
 * Banto の一部に見えるように。外部プラグインなので Banto の CSS は読み込まず、必要な分を写す。
 */
import { PURGE_REVOKED_AFTER_SECONDS } from "../store/purge";
import type { Child } from "hono/jsx";
import type { CronLimitHit } from "../budget";
import { raw } from "hono/html";
import type { Connection } from "../store/connections";
import { VERSION } from "../deps";
import type { People } from "./people";

const CSS = `
:root{
  color-scheme:light dark;
  --bg:#fff;--bg-page:#fafafa;--bg-subtle:#f5f5f5;--fg:#171717;--fg-muted:#666;--border:#eaeaea;--border-strong:#d4d4d4;
  --accent:#171717;--accent-fg:#fff;--link:#0062d1;
  --ok:#107d32;--ok-bg:#ebfaef;--warn:#9a5b00;--warn-bg:#fff7e6;--err:#cb2a2f;--err-bg:#ffeeee;--info:#0062d1;--info-bg:#eef5ff;
  --radius:8px;--radius-lg:12px;--shadow:0 1px 2px rgba(0,0,0,.04),0 1px 1px rgba(0,0,0,.02);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0a0a0a;--bg-page:#000;--bg-subtle:#171717;--fg:#ededed;--fg-muted:#a1a1a1;--border:#262626;--border-strong:#3d3d3d;
  --accent:#ededed;--accent-fg:#0a0a0a;--link:#52a8ff;
  --ok:#3ecf6e;--ok-bg:#0d2a17;--warn:#f5b041;--warn-bg:#2b1f08;--err:#ff6166;--err-bg:#2f1013;--info:#52a8ff;--info-bg:#0b1d33;
  --shadow:none;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-page);color:var(--fg);line-height:1.6;font-size:15px;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
main{max-width:64rem;margin:0 auto;padding:1.25rem 1.25rem 3rem}

/* 手代の帯（Banto の画面の中の、手代の中の目次） */
.tabs{display:flex;align-items:center;gap:.25rem;flex-wrap:wrap;padding:.5rem 1.25rem;border-bottom:1px solid var(--border);background:var(--bg)}
.tabs .brand{display:flex;align-items:center;gap:.5rem;font-weight:600;margin-right:.75rem;color:var(--fg)}
.tabs .brand .mark{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:700}
.tabs a.tab{padding:.35rem .7rem;border-radius:6px;color:var(--fg-muted);font-size:.9rem}
.tabs a.tab:hover{color:var(--fg);background:var(--bg-subtle);text-decoration:none}
.tabs a.tab[aria-current=page]{color:var(--fg);background:var(--bg-subtle);font-weight:500}

/* 文字 */
h1{font-size:1.5rem;font-weight:600;letter-spacing:-.02em;line-height:1.3;margin:0}
h2{font-size:1.1rem;font-weight:600;letter-spacing:-.01em;margin:2rem 0 .75rem}
h3{font-size:.95rem;font-weight:600;margin:0}
p{margin:.5rem 0}
.muted{color:var(--fg-muted);font-size:.875rem}
.small{font-size:.8rem}
code,.mono{font-family:var(--mono);font-size:.82em}
code{background:var(--bg-subtle);border:1px solid var(--border);border-radius:5px;padding:.05rem .35rem;white-space:nowrap}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:.5rem 0 1.25rem}
.page-head>div:first-child{flex:1 1 0;min-width:14rem}
.page-head p{margin:.35rem 0 0;color:var(--fg-muted);font-size:.9rem}
.page-head .actions{display:flex;gap:.5rem;flex-wrap:wrap}
.back{display:inline-block;font-size:.85rem;color:var(--fg-muted);margin:.25rem 0}

/* フォーム */
label{display:block;margin:.85rem 0 .3rem;font-size:.85rem;font-weight:500}
label.check{display:flex;align-items:flex-start;gap:.5rem;font-weight:400;margin:.5rem 0}
input[type=text],input[type=email],input[type=number],input[type=search],select,textarea{
  width:100%;max-width:32rem;min-height:38px;padding:.45rem .7rem;font:inherit;font-size:.9rem;color:var(--fg);background:var(--bg);
  border:1px solid var(--border-strong);border-radius:6px}
input[type=number]{max-width:8rem}
textarea{max-width:none;min-height:7rem;line-height:1.5}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--fg-muted);box-shadow:0 0 0 3px color-mix(in srgb,var(--fg) 12%,transparent)}
input[type=checkbox]{accent-color:var(--accent);width:16px;height:16px;margin:.2rem 0 0;flex:none}
.inline-fields{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:flex-end}
.inline-fields>div{flex:0 0 auto}
.inline-fields label{margin-top:.5rem}
.hint{color:var(--fg-muted);font-size:.8rem;margin:.3rem 0 0}
fieldset{border:1px solid var(--border);border-radius:var(--radius);padding:.5rem 1rem .75rem;background:var(--bg-subtle)}
legend{font-weight:500;padding:0 .35rem}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;height:36px;padding:0 .95rem;font:inherit;font-size:.875rem;font-weight:500;
  cursor:pointer;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);white-space:nowrap}
button:hover,.btn:hover{opacity:.88;text-decoration:none}
button.secondary,.btn.secondary{background:var(--bg);color:var(--fg);border-color:var(--border-strong)}
button.secondary:hover,.btn.secondary:hover{opacity:1;background:var(--bg-subtle)}
button.danger{background:var(--bg);color:var(--err);border-color:color-mix(in srgb,var(--err) 40%,transparent)}
button:focus-visible,.btn:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.row input[type=text],.row input[type=search]{flex:1 1 14rem;max-width:none}

/* 表 */
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;font-size:.875rem;box-shadow:var(--shadow)}
th{text-align:left;font-weight:500;font-size:.78rem;color:var(--fg-muted);background:var(--bg-subtle);padding:.55rem .85rem;border-bottom:1px solid var(--border);white-space:nowrap}
td{text-align:left;padding:.65rem .85rem;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
.table-wrap{overflow-x:auto;border-radius:var(--radius-lg)}
td.nowrap,th.nowrap{white-space:nowrap}
.id{font-family:var(--mono);font-size:.8rem;color:var(--fg-muted)}

/* 知らせ */
.notice{padding:.75rem 1rem;border:1px solid color-mix(in srgb,var(--ok) 35%,transparent);background:var(--ok-bg);border-radius:var(--radius);margin:1rem 0;font-size:.9rem}
.notice.bad{border-color:color-mix(in srgb,var(--err) 35%,transparent);background:var(--err-bg)}
.notice.warn{border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:var(--warn-bg)}
.notice.info{border-color:color-mix(in srgb,var(--info) 30%,transparent);background:var(--info-bg)}
.ok{color:var(--ok)}.bad{color:var(--err)}.warn{color:var(--warn)}
.badge{display:inline-flex;align-items:center;gap:.35rem;font-size:.75rem;font-weight:500;padding:.05rem .55rem;border-radius:999px;border:1px solid var(--border-strong);color:var(--fg-muted);background:var(--bg);white-space:nowrap}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:var(--ok-bg)}
.badge.bad{color:var(--err);border-color:color-mix(in srgb,var(--err) 35%,transparent);background:var(--err-bg)}
.badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:var(--warn-bg)}
.badge.info{color:var(--info);border-color:color-mix(in srgb,var(--info) 30%,transparent);background:var(--info-bg)}

/* カード */
.card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1rem 1.25rem;margin:0 0 1rem;box-shadow:var(--shadow)}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:.75rem;margin:0 0 1.25rem}
.grid .card{margin:0}
.metric{font-size:1.6rem;font-weight:600;letter-spacing:-.02em;line-height:1.2;margin:.2rem 0}
.metric small{font-size:.8rem;font-weight:400;color:var(--fg-muted);margin-left:.3rem}
.kv{display:grid;grid-template-columns:minmax(8rem,auto) 1fr;gap:.35rem 1rem;margin:0;font-size:.9rem}
.kv dt{color:var(--fg-muted)}
.kv dd{margin:0}
ul.list{list-style:none;padding:0;margin:0}
ul.list>li{display:flex;align-items:center;gap:.75rem;padding:.7rem 0;border-bottom:1px solid var(--border)}
ul.list>li:last-child{border-bottom:0}
ul.list>li .grow{flex:1;min-width:0}
ul.checklist{list-style:none;padding:0;margin:.25rem 0 0}
ul.checklist li{display:flex;gap:.5rem;align-items:baseline;padding:.25rem 0;font-size:.9rem}
ul.checklist li .mark{flex:none;width:1.1rem;text-align:center}
iframe.mail-preview{display:block;width:100%;height:32rem;border:1px solid var(--border);border-radius:var(--radius);background:#f4f4f5;margin:.35rem 0}
pre.sample{white-space:pre-wrap;font:inherit;font-size:.875rem;background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem .9rem;margin:.35rem 0}
details.fold{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);margin:.6rem 0}
details.fold>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:.6rem;padding:.65rem .9rem;font-weight:500;font-size:.9rem}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::before{content:"＋";color:var(--fg-muted);width:1rem;text-align:center}
details.fold[open]>summary::before{content:"－"}
details.fold>summary .grow{flex:1}
details.fold>.body{padding:0 1rem 1rem 2.6rem}
details.fold.on{border-color:var(--border-strong)}

/* ルールの流れ */
.layout{display:grid;grid-template-columns:minmax(0,1fr) 18rem;gap:1.25rem;align-items:start}
@media (max-width:860px){.layout{grid-template-columns:1fr}}
.side{position:sticky;top:1rem}
@media (max-width:860px){.side{position:static}.layout>.pick{order:-1}}
.step{position:relative}
.step-label{display:flex;align-items:center;gap:.6rem;margin:0 0 .5rem}
.step-label .num{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-size:.75rem;font-weight:600;flex:none}
.flow-arrow{text-align:center;color:var(--fg-muted);margin:-.5rem 0 .5rem;font-size:.9rem;line-height:1}
.sentence{font-size:1rem;line-height:1.7;padding:.85rem 1rem;border-left:3px solid var(--accent);background:var(--bg);border-radius:0 var(--radius) var(--radius) 0;margin:0 0 1rem;box-shadow:var(--shadow)}
.sentence b{font-weight:600}
@media (max-width:600px){main{padding:1rem 1rem 2.5rem}.tabs{padding:.5rem 1rem}h1{font-size:1.3rem}.kv{grid-template-columns:1fr}.kv dt{margin-top:.4rem}}
`;

export function Page(props: { title: string; children: Child }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>{props.title}</title>
        <style>{raw(CSS)}</style>
      </head>
      <body>{props.children}</body>
    </html>
  );
}

export type Tab = "home" | "notices" | "rules" | "runs" | "sets" | "settings";

/** 手代の中の目次（Banto の管理画面の中に出るので、Banto の帯とは別に小さく） */
export function Nav(props: { s: string; current?: Tab }) {
  const q = `?s=${encodeURIComponent(props.s)}`;
  // 作業の券が無い画面（手代の URL を直接開いた・期限切れ）には目次を出さない（押しても「開き直してください」になるだけ）
  if (!props.s) {
    return (
      <nav class="tabs" aria-label="手代">
        <span class="brand">
          <span class="mark" aria-hidden="true">
            手
          </span>
          手代
        </span>
      </nav>
    );
  }
  const tab = (key: Tab, href: string, label: string) => (
    <a class="tab" href={`${href}${q}`} aria-current={props.current === key ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <nav class="tabs" aria-label="手代">
      <span class="brand">
        <span class="mark" aria-hidden="true">
          手
        </span>
        手代
      </span>
      {tab("home", "/admin", "ホーム")}
      {tab("notices", "/admin/notices", "注文のお知らせ")}
      {tab("rules", "/admin/rules", "ルール")}
      {tab("runs", "/admin/runs", "送った記録")}
      {tab("sets", "/admin/sets", "商品の集まり")}
      {tab("settings", "/admin/settings", "設定")}
    </nav>
  );
}

/** 管理画面の 1 ページ（目次 + 本文） */
export function AdminPage(props: { s: string; title: string; current?: Tab; children: Child }) {
  return (
    <Page title={`${props.title} — 手代`}>
      <Nav s={props.s} current={props.current} />
      <main>{props.children}</main>
    </Page>
  );
}

export function PageHead(props: { title: string; lead?: Child; actions?: Child; back?: { href: string; label: string } }) {
  return (
    <>
      {props.back ? (
        <a class="back" href={props.back.href}>
          ← {props.back.label}
        </a>
      ) : null}
      <div class="page-head">
        <div>
          <h1>{props.title}</h1>
          {props.lead ? <p>{props.lead}</p> : null}
        </div>
        {props.actions ? <div class="actions">{props.actions}</div> : null}
      </div>
    </>
  );
}

export function Badge(props: { tone?: "ok" | "bad" | "warn" | "info"; children: Child }) {
  return <span class={props.tone ? `badge ${props.tone}` : "badge"}>{props.children}</span>;
}

/** 会員 ID などの長い ID: 頭の 8 桁だけ見せ、全部は title に（写すときは選べる） */
export function ShortId(props: { id: string }) {
  return (
    <span class="id" title={props.id}>
      {props.id.length > 13 ? `${props.id.slice(0, 8)}…` : props.id}
    </span>
  );
}

export function Landing(props: { missing: string[]; hookUrl: string }) {
  return (
    <Page title="手代">
      <Nav s="" />
      <main>
        <PageHead title="手代（tedai）" lead={`Banto の外部プラグインです。版 ${VERSION}`} />
        {props.missing.length > 0 ? (
          <div class="notice bad">
            <p>
              <strong>まだ設定が足りません:</strong> {props.missing.join("、")}
            </p>
            <p class="muted">Cloudflare の画面 → Workers & Pages → この Worker → 設定 → 変数とシークレット で入れてください（README の「置き方」）。</p>
          </div>
        ) : (
          <div class="card">
            <p>
              <strong>手代の画面は、Banto の管理画面から開きます。</strong>Banto の管理画面 → 連携 → 手代 を開いてください（この URL を直接開いても、ルールなどの画面は使えません）。
            </p>
            <p class="muted">まだつないでいなければ、Banto の管理画面 → 連携 で、受け口の URL に次を入れて「許してつなぐ」を押してください。</p>
            <p>
              <code>{props.hookUrl}</code>
            </p>
          </div>
        )}
      </main>
    </Page>
  );
}

export function Message(props: { title: string; tone: "ok" | "bad"; children: Child }) {
  return (
    <Page title={props.title}>
      <Nav s="" />
      <main>
        <div class={props.tone === "ok" ? "card" : "notice bad"} style="max-width:40rem;margin:2rem auto">
          <h1 class={props.tone} style="font-size:1.25rem">
            {props.title}
          </h1>
          {props.children}
        </div>
      </main>
    </Page>
  );
}

export const fmt = (sec: number) =>
  new Date(sec * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** 今からどれくらい前か（ホームの最近の動き） */
export function ago(sec: number, now: number): string {
  const d = Math.max(0, now - sec);
  if (d < 60) return "たった今";
  if (d < 3600) return `${Math.floor(d / 60)} 分前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 時間前`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} 日前`;
  return fmt(sec);
}

export interface DashboardData {
  connection: Connection;
  now: number;
  purchases: { orders: number; customers: number };
  favorites: { favorites: number; customers: number };
  sync: { caught_up: boolean; last_run_at: number | null; last_error: string | null } | null;
  /** Banto にトークンを断られ始めた時刻（hooks も来ないまま 30 日続くと、お客様に関わる記録を消す。src/store/purge.ts） */
  revokedSince?: number | null;
  rules: { active: number; record_only: number; other: number };
  week: { hits: number; sent: number; pending: number; failed: number };
  recent: { at: number; rule_id: string; rule_name: string; customer_id: string; kind: "hit" | "run"; status: string; summary: string }[];
  people?: People;
  setup: { mail: boolean; mailSettings: boolean; hasRules: boolean };
  /** Cron が Cloudflare の 1 回の上限の手前で止めた（直近 7 日。src/budget.ts） */
  limitHit?: CronLimitHit | null;
}

const LIMIT_STEPS: Record<string, string> = {
  runs: "アクションの列",
  time_rules: "時刻のきっかけ・お気に入りの商品の読み込み",
  prune: "記録の片づけ",
  order_sync: "注文の突き合わせ",
  favorite_sync: "お気に入りの取り込み",
  notices: "注文のお知らせ",
};

/** Cron が上限の手前で止めたことの知らせ */
export function LimitNotice(props: { hit: CronLimitHit }) {
  const h = props.hit;
  const what = h.kind === "d1" ? "D1 の問い合わせ" : "D1 と外への通信の合計";
  return (
    <div class="notice warn" role="alert">
      <strong>直近 7 日に、5 分ごとの仕事が Cloudflare の 1 回の上限に近いため、続けて途中で止まりました</strong>（最後は {fmt(h.at)}、{LIMIT_STEPS[h.step] ?? h.step}のところで{what}）。
      止めた分は次の回に続けますが、続くあいだはアクション・突き合わせが遅れます。
      {h.plan === "free" ? (
        <>
          {" "}
          Cloudflare の <strong>Workers の有料プラン</strong>にして、手代の Worker の変数 <code>WORKERS_PLAN</code> を <code>paid</code> にしてください（1 回に使える D1 の問い合わせが 50 から 1,000 に、通信の合計が 50 から 10,000 になります。README の「Workers のプラン」）。
        </>
      ) : (
        <> 有料プランの上限にも近づいています。ショップごとに手代を分けることを考えてください。</>
      )}
    </div>
  );
}

export function Dashboard(props: DashboardData & { s: string }) {
  const c = props.connection;
  const sy = props.sync;
  const q = `?s=${encodeURIComponent(props.s)}`;
  const syncBadge = !sy ? (
    <Badge tone="info">取り込み待ち</Badge>
  ) : sy.last_error ? (
    <Badge tone="bad">突き合わせに失敗</Badge>
  ) : sy.caught_up ? (
    <Badge tone="ok">追いついています</Badge>
  ) : (
    <Badge tone="info">過去の注文を取り込み中</Badge>
  );
  const todo = [
    { done: props.setup.hasRules, text: "ルールを作る", href: `/admin/rules/new${q}` },
    { done: props.setup.mail, text: "メールの送り手を決める（任意。Worker の変数 MAIL_TRANSPORT）", href: null },
    { done: props.setup.mailSettings, text: "送り手のアドレスと特定電子メール法の表示を入れる（メールを使うとき）", href: `/admin/settings${q}` },
  ];
  return (
    <AdminPage s={props.s} title="ホーム" current="home">
      <PageHead
        title={c.shop_name}
        lead={
          <>
            手代はこのショップの会員の購入を見て、決めておいたアプローチを自動で行います。 {syncBadge}
          </>
        }
        actions={
          <a class="btn" href={`/admin/rules/new${q}`}>
            ルールを作る
          </a>
        }
      />
      {props.limitHit ? <LimitNotice hit={props.limitHit} /> : null}
      {props.week.failed > 0 ? (
        <div class="notice bad">
          直近 7 日に、行えなかったアクションが {props.week.failed} 件あります。<a href={`/admin/rules${q}`}>ルール</a>の「送った記録」で理由を見てください。
        </div>
      ) : null}
      {sy?.last_error ? (
        <div class="notice bad">
          Banto との突き合わせに失敗しました（<code>{sy.last_error}</code>）。
          {sy.last_error.startsWith("401 ")
            ? `Banto にトークンを断られています（連携を外した・つないだ人の権限が変わった など）。6 時間に 1 回だけ試します。Banto で手代をつなぎ直してください。${
                props.revokedSince
                  ? `このまま Banto からの知らせも届かなければ、${Math.max(0, Math.ceil((props.revokedSince + PURGE_REVOKED_AFTER_SECONDS - props.now) / 86400))} 日後にお客様に関わる記録（購入・お気に入り・当たった記録・アクションの列）を消します。`
                  : ""
              }`
            : "5 分ごとにやり直します。続くときは、Banto で手代をつなぎ直してください。"}
        </div>
      ) : null}
      <div class="grid">
        <div class="card">
          <div class="muted">動いているルール</div>
          <div class="metric">
            {props.rules.active}
            <small>動かす</small>
          </div>
          <div class="muted small">記録だけ {props.rules.record_only} ・ ほか {props.rules.other}</div>
        </div>
        <div class="card">
          <div class="muted">直近 7 日に当たった人</div>
          <div class="metric">
            {props.week.hits.toLocaleString("ja-JP")}
            <small>人</small>
          </div>
          <div class="muted small">ルールごとの合計</div>
        </div>
        <div class="card">
          <div class="muted">直近 7 日に連絡した</div>
          <div class="metric">
            {props.week.sent.toLocaleString("ja-JP")}
            <small>通</small>
          </div>
          <div class="muted small">待ち {props.week.pending} 件</div>
        </div>
        <div class="card">
          <div class="muted">数えている注文</div>
          <div class="metric">
            {props.purchases.orders.toLocaleString("ja-JP")}
            <small>件</small>
          </div>
          <div class="muted small">
            会員 {props.purchases.customers.toLocaleString("ja-JP")} 人 ・ お気に入り {props.favorites.favorites.toLocaleString("ja-JP")} 件
          </div>
        </div>
      </div>

      {todo.some((t) => !t.done) ? (
        <div class="card">
          <h3>はじめに</h3>
          <ul class="checklist">
            {todo.map((t) => (
              <li>
                <span class={`mark ${t.done ? "ok" : "muted"}`}>{t.done ? "✓" : "○"}</span>
                <span class={t.done ? "muted" : ""}>{t.href && !t.done ? <a href={t.href}>{t.text}</a> : t.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <h2>最近の動き</h2>
      {props.recent.length === 0 ? (
        <div class="card">
          <p class="muted">まだありません。ルールを「記録だけ」か「動かす」にすると、会員の注文で条件に入った人がここに並びます。</p>
        </div>
      ) : (
        <div class="card" style="padding:.25rem 1.25rem">
          <ul class="list">
            {props.recent.map((r) => (
              <li>
                <span class="muted small nowrap" style="width:5.5rem;flex:none">
                  {ago(r.at, props.now)}
                </span>
                <span class="grow">
                  <a href={`/admin/rules/${r.rule_id}${q}`}>{r.rule_name}</a>
                  <span class="muted small">
                    {" "}
                    ・ <PersonLabel id={r.customer_id} people={props.people} />
                    {r.summary ? ` ・ ${r.summary}` : ""}
                  </span>
                </span>
                <RunBadge status={r.kind === "hit" ? "hit" : r.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>つないだ内容</h2>
      <div class="card">
        <dl class="kv">
          <dt>ショップ</dt>
          <dd>
            {c.shop_name} <span class="muted">（{c.shop_slug}）</span>
          </dd>
          <dt>つないだ日時</dt>
          <dd>{fmt(c.updated_at)}</dd>
          <dt>Banto との突き合わせ</dt>
          <dd>
            {syncBadge} {sy?.last_run_at ? <span class="muted small">最後: {fmt(sy.last_run_at)}</span> : null}
          </dd>
          <dt>許された権限</dt>
          <dd>{c.scopes.length > 0 ? c.scopes.map((x) => <code style="margin:0 .25rem .25rem 0;display:inline-block">{x}</code>) : <span class="muted">なし</span>}</dd>
          <dt>版</dt>
          <dd>
            手代 {VERSION} ・ Banto {c.banto_version ?? "—"}
          </dd>
        </dl>
      </div>
    </AdminPage>
  );
}

const RUN_BADGE: Record<string, { tone?: "ok" | "bad" | "warn" | "info"; label: string }> = {
  hit: { tone: "info", label: "当たった" },
  pending: { tone: "warn", label: "待ち" },
  done: { tone: "ok", label: "済み" },
  skipped: { label: "飛ばした" },
  failed: { tone: "bad", label: "失敗" },
};

export function RunBadge(props: { status: string }) {
  const b = RUN_BADGE[props.status] ?? { label: props.status };
  return <Badge tone={b.tone}>{b.label}</Badge>;
}

/** 名前（無ければ「名前なし」）とメールの一部。読めていなければ会員 ID の頭 */
export function PersonLabel(props: { id: string; people?: People }) {
  const p = props.people?.get(props.id);
  if (!p) return <ShortId id={props.id} />;
  return (
    <span title={props.id}>
      {p.name ?? <span class="muted">名前なし</span>}
      {p.email ? <span class="muted small"> {p.email}</span> : null}
    </span>
  );
}
