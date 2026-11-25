/** @jsxImportSource hono/jsx */
/**
 * 商品の集まり・ルール・設定の画面（サーバーで描く。スクリプトなし）。
 * ルールの編集は「きっかけ → 条件 → 待ち → アクション」の流れで並べ、使う部品だけを開く。上にルールの意味を 1 文で出す。
 */
import type { Child } from "hono/jsx";
import type { CategoryRef, ProductRef } from "../banto/catalog";
import type { CouponRef } from "../banto/members";
import { CHANNELS, EMAIL_FORMATS, PLACEHOLDERS, describeActions, emailFormatOf, parseActionsForm, render, type Actions } from "../rules/actions";
import { composeHtmlMail } from "../mail/html";
import { MODES, RULE_STATUSES, describe, parseConditionForm, type Condition } from "../rules/condition";
import { TRIGGERS, describeTrigger, isFavoriteTrigger, isTimeTrigger, parseTriggerForm, type Trigger } from "../rules/triggers";
import type { Explanation } from "../rules/explain";
import { messageSummary, type Steps } from "../runs/execute";
import type { Hit, ProductSet, Rule, SetItem } from "../store/rules";
import { MAX_SET_ITEMS } from "../store/rules";
import type { ShopSettings } from "../store/settings";
import { AdminPage, Badge, PageHead, PersonLabel, RunBadge, ShortId, fmt } from "./views";
import type { People } from "./people";

const MESSAGES: Record<string, { text: string; bad?: boolean }> = {
  saved: { text: "保存しました。" },
  deleted: { text: "消しました。" },
  in_use: { text: "ルールで使っている集まりは消せません。先にルールの条件から外してください。", bad: true },
  too_many: { text: "これ以上は作れません（上限）。", bad: true },
  added: { text: "足しました。" },
  removed: { text: "外しました。" },
  full: { text: `1 つの集まりに入れられる商品は ${MAX_SET_ITEMS} 個までです。`, bad: true },
  truncated: { text: "商品が多いので、新しい 500 個の中からだけ足しました。古い商品は検索して足してください。", bad: true },
  banto_error: { text: "Banto から読めませんでした。少し待ってからやり直してください。", bad: true },
  name_required: { text: "名前を入れてください（100 文字まで）。", bad: true },
  test_sent: { text: "試しに 1 通送りました。運営者の宛先の受信箱（迷惑メールのフォルダも）を見てください。" },
  none_selected: { text: "商品が選ばれていません。チェックを入れてから押してください（何も変えていません）。", bad: true },
  retried: { text: "送り直す列に戻しました。数分で送ります。" },
  owner_only: { text: "この画面を使える人を変えられるのは、持ち主だけです。", bad: true },
  notice_test_sent: { text: "試しに送りました（文面は保存していません）。届くまで少しかかることがあります。迷惑メールのフォルダも確かめてください。" },
  reset: { text: "既定の文面に戻しました（まだ保存していません。確かめて保存してください）。" },
};

export function Flash(props: { msg?: string }) {
  const m = props.msg ? MESSAGES[props.msg] : undefined;
  return m ? <p class={m.bad ? "notice bad" : "notice"}>{m.text}</p> : null;
}

export const Hidden = (props: { s: string }) => <input type="hidden" name="s" value={props.s} />;
export const q = (s: string) => `?s=${encodeURIComponent(s)}`;

export function Errors(props: { errors: string[] }) {
  if (props.errors.length === 0) return null;
  return (
    <div class="notice bad" role="alert">
      <strong>直してください</strong>
      <ul style="margin:.35rem 0 0;padding-left:1.25rem">
        {props.errors.map((e) => (
          <li>{e}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 商品の集まり ----------

export function SetsPage(props: { s: string; sets: ProductSet[]; msg?: string; query?: string }) {
  const query = (props.query ?? "").trim();
  const shown = query ? props.sets.filter((x) => x.name.toLowerCase().includes(query.toLowerCase())) : props.sets;
  return (
    <AdminPage s={props.s} title="商品の集まり" current="sets">
      <PageHead title="商品の集まり" lead="ルールの条件「この商品を買った」に使う商品のまとまりです。SKU ではなく商品で数えます（カラー違いは同じ商品）。" />
      <Flash msg={props.msg} />
      <div class="card">
        <form method="post" action="/admin/sets" class="row">
          <Hidden s={props.s} />
          <input type="text" name="name" maxlength={100} required placeholder="新しい集まりの名前（例: 秋のコーデ 3 点）" aria-label="集まりの名前" />
          <button>作る</button>
        </form>
      </div>
      {props.sets.length > 0 ? (
        <form method="get" action="/admin/sets" class="row" style="margin:0 0 .75rem">
          <Hidden s={props.s} />
          <input type="search" name="q" value={query} maxlength={100} placeholder="集まりの名前で探す" aria-label="集まりを探す" />
          <button class="secondary">探す</button>
          {query ? <a href={`/admin/sets${q(props.s)}`}>すべて（{props.sets.length}）</a> : null}
        </form>
      ) : null}
      {props.sets.length === 0 ? (
        <div class="card">
          <p class="muted">まだありません。上で名前を付けて作り、商品を足してください。</p>
        </div>
      ) : shown.length === 0 ? (
        <div class="card">
          <p class="muted">「{query}」に合う集まりはありません。</p>
        </div>
      ) : (
        <div class="card" style="padding:.25rem 1.25rem">
          <ul class="list">
            {shown.map((x) => (
              <li>
                <span class="grow">
                  <a href={`/admin/sets/${x.id}${q(props.s)}`} style="font-weight:500">
                    {x.name}
                  </a>
                </span>
                <Badge tone={x.count > 0 ? undefined : "warn"}>{x.count} 商品</Badge>
                <span class="muted small nowrap">{fmt(x.updated_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </AdminPage>
  );
}

export function SetEditPage(props: {
  s: string;
  set: ProductSet;
  items: SetItem[];
  query: string;
  results: ProductRef[] | null;
  categories: CategoryRef[] | null;
  msg?: string;
}) {
  const have = new Set(props.items.map((i) => i.product_id));
  const action = `/admin/sets/${props.set.id}`;
  return (
    <AdminPage s={props.s} title={props.set.name} current="sets">
      <PageHead
        title={props.set.name}
        lead={`${props.items.length} / ${MAX_SET_ITEMS} 商品`}
        back={{ href: `/admin/sets${q(props.s)}`, label: "商品の集まり" }}
      />
      <Flash msg={props.msg} />
      <div class="layout">
        <div>
          <div class="card">
            <h3>入っている商品</h3>
            {props.items.length === 0 ? (
              <p class="muted">まだありません。右（狭い画面では上）で探して足してください。</p>
            ) : (
              <form method="post" action={action}>
                <Hidden s={props.s} />
                <input type="hidden" name="op" value="remove" />
                <ul class="list">
                  {props.items.map((i) => (
                    <li>
                      <label class="check" style="margin:0;flex:1">
                        <input type="checkbox" name="product_id" value={i.product_id} />
                        <span>
                          {i.product_name} <span class="muted small">{i.product_slug}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p>
                  <button class="danger">選んだものを外す</button>
                </p>
              </form>
            )}
          </div>
        </div>
        <div class="pick">
          <div class="card">
            <h3>商品を探して足す</h3>
            <form method="get" action={action} class="row" style="margin-top:.5rem">
              <Hidden s={props.s} />
              <input type="search" name="q" value={props.query} maxlength={100} placeholder="商品名か URL の名前" aria-label="商品を探す" />
              <button class="secondary">探す</button>
            </form>
            {props.results === null ? null : props.results.length === 0 ? (
              <p class="muted">見つかりませんでした。</p>
            ) : (
              <form method="post" action={action}>
                <Hidden s={props.s} />
                <input type="hidden" name="op" value="add" />
                {props.results.map((p) => (
                  <label class="check">
                    <input type="checkbox" name="product" value={JSON.stringify({ id: p.id, slug: p.slug, name: p.name })} disabled={have.has(p.id)} />
                    <span>
                      {p.name}
                      <span class="muted small">
                        {" "}
                        {p.slug}
                        {p.published ? "" : "（非公開）"}
                        {have.has(p.id) ? "（入っています）" : ""}
                      </span>
                    </span>
                  </label>
                ))}
                <p>
                  <button>選んだものを足す</button>
                </p>
              </form>
            )}
          </div>
          {props.categories && props.categories.length > 0 ? (
            <div class="card">
              <h3>カテゴリーからまとめて足す</h3>
              <p class="hint">下のカテゴリーの商品も足します。今の商品を写すので、あとでカテゴリーに入れた商品は入りません。</p>
              <form method="post" action={action} class="row" style="margin-top:.5rem">
                <Hidden s={props.s} />
                <input type="hidden" name="op" value="add_category" />
                <select name="category_id" aria-label="カテゴリー" style="flex:1">
                  {props.categories.map((c) => (
                    <option value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button class="secondary">足す</button>
              </form>
            </div>
          ) : null}
          <div class="card">
            <h3>名前と削除</h3>
            <form method="post" action={action} class="row" style="margin-top:.5rem">
              <Hidden s={props.s} />
              <input type="hidden" name="op" value="rename" />
              <input type="text" name="name" maxlength={100} required value={props.set.name} aria-label="集まりの名前" />
              <button class="secondary">名前を変える</button>
            </form>
            <form method="post" action={action} style="margin-top:.75rem">
              <Hidden s={props.s} />
              <input type="hidden" name="op" value="delete" />
              <button class="danger">この集まりを消す</button>
            </form>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}

// ---------- ルール ----------

/** ルールの決まり（当たらない理由のほとんどはここ） */
export function RuleBasics(props: { open?: boolean }) {
  return (
    <details class="fold" open={props.open}>
      <summary>
        <span class="grow">ルールの決まり（当たらないときはまずここ）</span>
      </summary>
      <div class="body">
        <ul style="margin:0;padding-left:1.1rem">
          <li>きっかけは「会員の注文が支払われた」「最後の購入から n 日」「初めての購入から n 日」です。ゲストの注文・キャンセルされた注文は数えません。</li>
          <li>
            当たるのは、<strong>ちょうど条件に入った会員</strong>だけです（注文のきっかけはその注文で、n 日のきっかけはちょうど n 日を過ぎたとき）。ルールを動かし始める前にもう満たしていた会員には当たりません。
          </li>
          <li>
            <strong>同じ会員に同じルールは 1 回だけ</strong>です。試し直すときは、新しいルールを作ってください。
          </li>
          <li>「動かす」のアクションは 5 分ごとに行います。お客様への連絡は、夜とお客様ごとの上限（設定）を守って後ろへずらします。</li>
          <li>当たらない理由は、ルールの画面の「会員で確かめる」で見られます。</li>
        </ul>
      </div>
    </details>
  );
}

const STATUS_BADGE: Record<string, { tone?: "ok" | "info" | "warn"; label: string }> = {
  active: { tone: "ok", label: "動かす" },
  record_only: { tone: "info", label: "記録だけ" },
  draft: { label: "下書き" },
  paused: { tone: "warn", label: "止めている" },
};

export function StatusBadge(props: { status: string }) {
  const b = STATUS_BADGE[props.status] ?? { label: props.status };
  return <Badge tone={b.tone}>{b.label}</Badge>;
}

/** ルールの意味を 1 文に（「会員の注文が支払われたとき、… なら、… する」） */
export function RuleSentence(props: {
  trigger: Trigger;
  condition: Condition | null;
  actions: Actions | null;
  status: string;
  setName: (id: string) => string;
  couponName: (id: string) => string;
  optionNames?: Record<string, string>;
}) {
  const conds = props.condition ? describe(props.condition, props.setName) : [];
  const acts = props.actions ? describeActions({ ...props.actions, wait_days: 0 }, props.couponName) : [];
  const wait = props.actions && props.actions.wait_days > 0 ? `${props.actions.wait_days} 日後に` : "";
  const doing = props.status === "active" ? (acts.length > 0 ? `${wait}${acts.join("・")}` : "（アクションを選んでください）") : props.status === "record_only" ? "記録します（送りません）" : "（下書き・止めているあいだは動きません）";
  return (
    <p class="sentence">
      <b>{describeTrigger(props.trigger, props.optionNames)}</b>、
      {conds.length > 0 ? (
        <>
          <b>{conds.join("、かつ ")}</b>なら、
        </>
      ) : props.trigger.kind !== "order.paid" ? (
        ""
      ) : (
        <>
          <span class="muted">（条件を選んでください）</span>なら、
        </>
      )}
      <b>{doing}</b>。
    </p>
  );
}

export function RulesPage(props: {
  s: string;
  rules: Rule[];
  sets: ProductSet[];
  hits: Record<string, number>;
  coupons: CouponRef[];
  runs?: Record<string, { pending: number; failed: number }>;
  msg?: string;
  query?: string;
  optionNames?: Record<string, string>;
}) {
  const query = (props.query ?? "").trim();
  const shown = query ? props.rules.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())) : props.rules;
  const setName = (id: string) => props.sets.find((x) => x.id === id)?.name ?? "（消えた集まり）";
  const couponName = (id: string) => props.coupons.find((c) => c.id === id)?.name ?? "（クーポン）";
  return (
    <AdminPage s={props.s} title="ルール" current="rules">
      <PageHead
        title="ルール"
        lead="会員の購入に応じて、決めておいたアプローチとお店の作業を自動で行います。"
        actions={
          <a class="btn" href={`/admin/rules/new${q(props.s)}`}>
            新しいルール
          </a>
        }
      />
      <Flash msg={props.msg} />
      <RuleBasics open={props.rules.length === 0} />
      {props.rules.length > 0 ? (
        <form method="get" action="/admin/rules" class="row" style="margin:.75rem 0">
          <Hidden s={props.s} />
          <input type="search" name="q" value={query} maxlength={100} placeholder="ルールの名前で探す" aria-label="ルールを探す" />
          <button class="secondary">探す</button>
          {query ? <a href={`/admin/rules${q(props.s)}`}>すべて（{props.rules.length}）</a> : null}
        </form>
      ) : null}
      {query && shown.length === 0 ? (
        <div class="card">
          <p class="muted">「{query}」に合うルールはありません。</p>
        </div>
      ) : null}
      {props.rules.length === 0 ? (
        <div class="card">
          <p class="muted">まだありません。「新しいルール」から作ってください。最初は状態を「記録だけ」にして、当たる人を見てから「動かす」にするのがおすすめです。</p>
        </div>
      ) : (
        shown.map((r) => {
          const run = props.runs?.[r.id];
          return (
            <div class="card">
              <div class="row" style="justify-content:space-between">
                <a href={`/admin/rules/${r.id}${q(props.s)}`} style="font-weight:600;font-size:1rem">
                  {r.name}
                </a>
                <StatusBadge status={r.status} />
              </div>
              <p class="muted" style="margin:.4rem 0">
                {[describeTrigger(r.trigger, props.optionNames), ...describe(r.condition, setName)].join("、")}
                {r.status === "active" && describeActions(r.actions, couponName).length > 0 ? ` → ${describeActions(r.actions, couponName).join("・")}` : ""}
              </p>
              <div class="row small">
                <a href={`/admin/rules/${r.id}/hits${q(props.s)}`}>当たった人 {(props.hits[r.id] ?? 0).toLocaleString("ja-JP")} 人</a>
                <span class="muted">・</span>
                <a href={`/admin/rules/${r.id}/runs${q(props.s)}`}>送った記録</a>
                {run && run.pending > 0 ? <Badge tone="warn">待ち {run.pending}</Badge> : null}
                {run && run.failed > 0 ? <Badge tone="bad">失敗 {run.failed}</Badge> : null}
              </div>
            </div>
          );
        })
      )}
    </AdminPage>
  );
}

export interface RuleForm {
  id: string | null;
  name: string;
  status: string;
  fields: Record<string, string | undefined>;
}

/** 保存したルールを画面のフォームの値に */
export function ruleToForm(r: Rule): RuleForm {
  const c = r.condition;
  const f: Record<string, string | undefined> = {};
  if (c.purchase) {
    f["purchase_on"] = "1";
    f["set_id"] = c.purchase.set_id;
    f["mode"] = c.purchase.mode;
    f["n"] = String(c.purchase.n);
    f["purchase_days"] = c.purchase.days ? String(c.purchase.days) : "";
  }
  if (c.orders_at_least) {
    f["orders_on"] = "1";
    f["orders_n"] = String(c.orders_at_least.n);
    f["orders_days"] = c.orders_at_least.days ? String(c.orders_at_least.days) : "";
  }
  if (c.spend_at_least) {
    f["spend_on"] = "1";
    f["spend_yen"] = String(c.spend_at_least.yen);
    f["spend_days"] = c.spend_at_least.days ? String(c.spend_at_least.days) : "";
  }
  const a = r.actions;
  if (a.attribute) {
    f["attr_on"] = "1";
    f["attr_key"] = a.attribute.key;
    f["attr_value"] = a.attribute.value;
  }
  if (a.order_tags.length > 0) {
    f["tags_on"] = "1";
    f["order_tags"] = a.order_tags.join(", ");
  }
  if (a.coupon_id) {
    f["coupon_on"] = "1";
    f["coupon_id"] = a.coupon_id;
  }
  if (a.message) {
    f["message_on"] = "1";
    f["channel"] = a.message.channel;
    f["line_text"] = a.message.line_text;
    f["line_image_url"] = a.message.line_image_url ?? "";
    f["line_button_label"] = a.message.line_button_label ?? "";
    f["line_button_url"] = a.message.line_button_url ?? "";
    f["email_subject"] = a.message.email_subject;
    f["email_body"] = a.message.email_body;
    f["email_format"] = emailFormatOf(a.message);
  }
  if (a.notify_slack) f["slack_on"] = "1";
  if (a.notify_email) f["opmail_on"] = "1";
  f["trigger"] = r.trigger.kind;
  // OFF も空の文字で必ず入れる（無いと画面が「新規の既定」と取り違えて ON を出していた）
  f["exclude_bought"] = r.trigger.excludeBought !== false ? "1" : "";
  f["variant_unit"] = r.trigger.unit ?? "product";
  f["variant_axes"] = (r.trigger.axes ?? []).join(",");
  f["trigger_days"] = r.trigger.days ? String(r.trigger.days) : "";
  f["wait_days"] = String(a.wait_days);
  if (a.recheck) f["recheck"] = "1";
  return { id: r.id, name: r.name, status: r.status, fields: f };
}

/** 文の見本（差し込みは見本の値で） */
export function MessageSample(props: { fields: Record<string, string | undefined>; shopName: string; settings: ShopSettings }) {
  const f = props.fields;
  if (!f["message_on"]) return null;
  const values = { name: "山田 花子", shop: props.shopName, coupon_code: "ABCD-1234", product_name: "リネンシャツ", product_url: "https://shop.example.com/products/linen-shirt", variant: "カラー: 赤" };
  const ch = f["channel"] ?? "";
  const s = props.settings;
  const footerLines = [`送信者: ${s.sender_name || "（設定で入れてください）"}`, `住所: ${s.sender_address || "（設定で入れてください）"}`, `お問い合わせ: ${s.sender_contact || "（設定で入れてください）"}`];
  return (
    <div>
      <p class="small muted" style="margin-top:.75rem">
        <strong>文の見本</strong>（差し込みは見本の値）
      </p>
      {ch !== "email" ? (
        <>
          <p class="small muted">LINE</p>
          <pre class="sample">{render(f["line_text"] ?? "", values)}</pre>
          {f["line_button_label"] ? (
            <p class="small muted">
              ボタン: {f["line_button_label"]} → {f["line_button_url"]}
            </p>
          ) : null}
        </>
      ) : null}
      {ch !== "line" ? (
        <>
          <p class="small muted">メール: {render(f["email_subject"] ?? "", values)}</p>
          {f["email_format"] === "html" ? (
            <iframe
              class="mail-preview"
              title="メールの見本"
              sandbox=""
              srcdoc={
                composeHtmlMail({
                  subject: render(f["email_subject"] ?? "", values),
                  source: f["email_body"] ?? "",
                  values,
                  design: { accent: s.mail_accent, logoUrl: s.mail_logo_url, shopName: props.shopName },
                  footer: { lines: footerLines, unsubscribeUrl: "https://example.invalid/u/…" },
                }).html
              }
            />
          ) : (
            <pre class="sample">
              {render(f["email_body"] ?? "", values)}
              {"\n\n――――――――――\n"}
              {`${footerLines.join("\n")}\nこのお知らせの配信を止める: https://…`}
            </pre>
          )}
          <p class="hint">メールは、案内メールに同意した会員だけに送ります（同意は送る直前に Banto で確かめます）。</p>
        </>
      ) : null}
    </div>
  );
}

export interface ActionChoices {
  /** カゴ落ちを最後に受け取った時刻（受け取る出来事に入っているかの目安） */
  lastAbandonedAt?: number | null;
  /** ショップのオプションの名前の表（お気に入りのきっかけの「オプションを選ぶ」に出す。手代が商品を読んだときに覚えたもの） */
  optionNames?: Record<string, string>;
  coupons: CouponRef[] | null;
  mailTransport: string | null;
  slack: boolean;
  settings: ShopSettings;
  shopName: string;
}

/** 使う・使わないで開け閉めする部品（スクリプトなし: details と「使う」のチェック） */
function Part(props: { name: string; title: string; on: boolean; summary?: string; children: Child; note?: Child }) {
  return (
    <details class={props.on ? "fold on" : "fold"} open={props.on}>
      <summary>
        <span class="grow">{props.title}</span>
        {props.on ? <Badge tone="ok">使う</Badge> : <span class="muted small">使わない</span>}
      </summary>
      <div class="body">
        <label class="check">
          <input type="checkbox" name={props.name} value="1" checked={props.on} />
          <span>この{props.summary ?? "部品"}を使う</span>
        </label>
        {props.note ? <p class="hint">{props.note}</p> : null}
        {props.children}
      </div>
    </details>
  );
}

function Days(props: { name: string; value: string }) {
  return (
    <div>
      <label for={props.name}>期間（直近の日数）</label>
      <input type="number" id={props.name} name={props.name} min={1} max={3650} value={props.value} placeholder="空ならいつでも" />
    </div>
  );
}

function ConditionStep(props: { f: Record<string, string | undefined>; sets: ProductSet[]; s: string }) {
  const f = props.f;
  const v = (k: string) => f[k] ?? "";
  return (
    <div class="card step">
      <div class="step-label">
        <span class="num">2</span>
        <h3>条件（使うものをすべて満たしたら当たる）</h3>
      </div>
      <Part name="purchase_on" title="商品の集まりを買った" summary="条件" on={!!f["purchase_on"]}>
        {props.sets.length === 0 ? (
          <p class="notice warn">
            先に<a href={`/admin/sets${q(props.s)}`}>商品の集まり</a>を作ってください。
          </p>
        ) : (
          <>
            <label for="set_id">集まり</label>
            <select id="set_id" name="set_id">
              {props.sets.map((x) => (
                <option value={x.id} selected={v("set_id") === x.id}>
                  {x.name}（{x.count} 商品）
                </option>
              ))}
            </select>
            <label for="mode">数え方</label>
            <select id="mode" name="mode">
              {MODES.map((m) => (
                <option value={m.value} selected={v("mode") === m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <div class="inline-fields">
              <div>
                <label for="n">n</label>
                <input type="number" id="n" name="n" min={1} max={10000} value={v("n") || "1"} />
              </div>
              <Days name="purchase_days" value={v("purchase_days")} />
            </div>
            <p class="hint">n は「n 種類以上」「合計 n 点以上」のときだけ使います。</p>
          </>
        )}
      </Part>
      <Part name="orders_on" title="注文の回数" summary="条件" on={!!f["orders_on"]}>
        <div class="inline-fields">
          <div>
            <label for="orders_n">何回以上</label>
            <input type="number" id="orders_n" name="orders_n" min={1} max={10000} value={v("orders_n")} placeholder="例: 2" />
          </div>
          <Days name="orders_days" value={v("orders_days")} />
        </div>
      </Part>
      <Part name="spend_on" title="累計の購入額" summary="条件" on={!!f["spend_on"]}>
        <div class="inline-fields">
          <div>
            <label for="spend_yen">何円以上（値引き後・送料込み）</label>
            <input type="number" id="spend_yen" name="spend_yen" min={1} value={v("spend_yen")} placeholder="例: 10000" style="max-width:10rem" />
          </div>
          <Days name="spend_days" value={v("spend_days")} />
        </div>
      </Part>
    </div>
  );
}

function ActionsStep(props: { s: string; f: Record<string, string | undefined>; choices: ActionChoices }) {
  const f = props.f;
  const v = (k: string) => f[k] ?? "";
  const c = props.choices;
  return (
    <>
      <div class="card step">
        <div class="step-label">
          <span class="num">3</span>
          <h3>待ち</h3>
        </div>
        <div class="inline-fields">
          <div>
            <label for="wait_days">当たってから行うまで</label>
            <div class="row">
              <input type="number" id="wait_days" name="wait_days" min={0} max={90} value={v("wait_days") || "0"} />
              <span class="muted">日後（0 ならすぐ。90 日まで）</span>
            </div>
          </div>
        </div>
        <label class="check">
          <input type="checkbox" name="recheck" value="1" checked={!!f["recheck"]} />
          <span>待ったあと、行う直前に条件を確かめ直す（キャンセル・期間切れなら行わない）</span>
        </label>
      </div>
      <div class="flow-arrow" aria-hidden="true">
        ↓
      </div>
      <div class="card step">
        <div class="step-label">
          <span class="num">4</span>
          <h3>アクション（「動かす」のとき、上から順に行う）</h3>
        </div>
        <Part name="attr_on" title="会員の項目を書く" summary="アクション" on={!!f["attr_on"]} note="Banto の「会員の項目」に定義したキーだけ書けます。会員の条件（会員価格・限定商品・ページの出し分け）につながります。">
          <div class="inline-fields">
            <div style="flex:1 1 12rem">
              <label for="attr_key">キー</label>
              <input type="text" id="attr_key" name="attr_key" maxlength={64} value={v("attr_key")} placeholder="例: segment" />
            </div>
            <div style="flex:1 1 12rem">
              <label for="attr_value">値</label>
              <input type="text" id="attr_value" name="attr_value" maxlength={200} value={v("attr_value")} placeholder="例: vip" />
            </div>
          </div>
        </Part>
        <Part name="tags_on" title="きっかけの注文に印を付ける" summary="アクション" on={!!f["tags_on"]}>
          <label for="order_tags">印（カンマ区切り、5 個まで）</label>
          <input type="text" id="order_tags" name="order_tags" maxlength={250} value={v("order_tags")} placeholder="例: 同梱物あり" />
        </Part>
        <Part name="coupon_on" title="クーポンを配る" summary="アクション" on={!!f["coupon_on"]} note={<>会員 1 人に 1 枚。もう持っている人には配らず、持っている分のコードを使います。文に {"{{coupon_code}}"} で差し込めます。</>}>
          {c.coupons === null ? (
            <p class="notice bad">Banto からクーポンを読めませんでした（モジュール「クーポン」が OFF か、権限が無い）。</p>
          ) : c.coupons.length === 0 ? (
            <p class="notice warn">Banto にクーポンがありません。Banto の管理画面で作ってください。</p>
          ) : (
            <>
              <label for="coupon_id">配るクーポン</label>
              <select id="coupon_id" name="coupon_id">
                {c.coupons.map((x) => (
                  <option value={x.id} selected={v("coupon_id") === x.id}>
                    {x.name}
                    {x.active ? "" : "（止めている）"}
                  </option>
                ))}
              </select>
            </>
          )}
        </Part>
        <Part name="message_on" title="お客様に連絡する" summary="アクション" on={!!f["message_on"]}>
          <label for="channel">手段</label>
          <select id="channel" name="channel">
            {CHANNELS.map((ch) => (
              <option value={ch.value} selected={v("channel") === ch.value}>
                {ch.label}
              </option>
            ))}
          </select>
          <p class="hint">
            差し込み: {PLACEHOLDERS.map((p) => <code style="margin-right:.25rem">{`{{${p}}}`}</code>)}（名前・ショップ・クーポンのコード・商品の名前・商品の URL・オプション。商品の 3 つはお気に入りのきっかけのときだけ）
          </p>
          <h3 style="margin-top:1rem">LINE</h3>
          <p class="hint">Banto がショップの公式アカウントから送ります（宣伝の月の上限あり）。</p>
          <label for="line_text">文（1,500 文字まで）</label>
          <textarea id="line_text" name="line_text" maxlength={1500}>
            {v("line_text")}
          </textarea>
          <label for="line_image_url">画像（https:// の URL、任意）</label>
          <input type="text" id="line_image_url" name="line_image_url" value={v("line_image_url")} />
          <div class="inline-fields">
            <div style="flex:1 1 10rem">
              <label for="line_button_label">ボタンの文字（20 文字まで、任意）</label>
              <input type="text" id="line_button_label" name="line_button_label" maxlength={20} value={v("line_button_label")} />
            </div>
            <div style="flex:2 1 14rem">
              <label for="line_button_url">ボタンのリンク（https://）</label>
              <input type="text" id="line_button_url" name="line_button_url" value={v("line_button_url")} />
            </div>
          </div>
          <h3 style="margin-top:1.25rem">メール</h3>
          {!c.mailTransport ? <p class="notice warn">メールの送り手がまだありません（Worker の変数 MAIL_TRANSPORT ほか）。LINE だけなら使えます。</p> : null}
          <label for="email_subject">件名</label>
          <input type="text" id="email_subject" name="email_subject" maxlength={150} value={v("email_subject")} />
          <label for="email_format">形</label>
          <select id="email_format" name="email_format">
            {EMAIL_FORMATS.map((x) => (
              <option value={x.value} selected={(v("email_format") || "text") === x.value}>
                {x.label}
              </option>
            ))}
          </select>
          <label for="email_body">本文</label>
          <textarea id="email_body" name="email_body" maxlength={5000}>
            {v("email_body")}
          </textarea>
          <details class="hint">
            <summary>飾りありの書き方</summary>
            <p class="small">
              飾りありのときは、本文を次の書き方で書くと、手代のレイアウト（
              <a href={`/admin/settings${q(props.s)}`}>設定</a>の色とロゴ）に流し込みます。HTML は直接書けません。文字だけの版も同じ本文から作って一緒に送ります。
            </p>
            <pre class="sample">{`# 見出し
## 小見出し
段落は空行で分けます。**太字** や [リンク](https://…) も使えます。
- 箇条書き
---
![画像の説明](https://…/image.jpg)
[[ボタンの文字]](https://…)`}</pre>
            <p class="small">リンクとボタンの先は https:// の URL か、先まるごとの {"{{product_url}}"} です（URL の中に差し込みは書けません）。画像は https:// の URL だけです。</p>
          </details>
          <p class="hint">送り手の表示（特定電子メール法）と配信停止のリンクは、手代が最後に付けます。</p>
        </Part>
        <Part name="slack_on" title="運営者に Slack で知らせる" summary="アクション" on={!!f["slack_on"]} note="載せるのは、ルールの名前・会員 ID・注文 ID・連絡の結果だけです。">
          {c.slack ? <p class="ok small">Slack は設定済みです。</p> : <p class="notice warn">Worker のシークレット SLACK_WEBHOOK_URL が要ります。</p>}
        </Part>
        <Part name="opmail_on" title="運営者にメールで知らせる" summary="アクション" on={!!f["opmail_on"]} note="載せるのは、ルールの名前・会員 ID・注文 ID・連絡の結果だけです。">
          <p class="small">
            宛先は<a href={`/admin/settings${q(props.s)}`}>設定</a>の「運営者への知らせ」です。
          </p>
        </Part>
      </div>
    </>
  );
}

export function RuleEditPage(props: {
  s: string;
  form: RuleForm;
  sets: ProductSet[];
  errors: string[];
  preview: { count: number; sample: string[]; condition: Condition; people?: People } | null;
  choices: ActionChoices;
  stats?: { hits: number; pending: number; failed: number };
  msg?: string;
}) {
  const f = props.form.fields;
  const setName = (id: string) => props.sets.find((x) => x.id === id)?.name ?? "（消えた集まり）";
  const couponName = (id: string) => props.choices.coupons?.find((c) => c.id === id)?.name ?? "（クーポン）";
  // 1 文の説明は、今のフォームの値から（形が違う部品は出さない）
  const trig = parseTriggerForm(f).trigger;
  const cond = parseConditionForm(f, new Set(props.sets.map((x) => x.id)), { allowEmpty: trig.kind !== "order.paid" });
  const acts = parseActionsForm(f, { productTrigger: true, mailTransport: true, mailSettings: true, operatorEmail: true, slack: true }).actions;
  const title = props.form.id ? props.form.name : "新しいルール";
  return (
    <AdminPage s={props.s} title={title} current="rules">
      <PageHead
        title={title}
        back={{ href: `/admin/rules${q(props.s)}`, label: "ルール" }}
        actions={
          props.form.id && props.stats ? (
            <div class="row small">
              <a href={`/admin/rules/${props.form.id}/hits${q(props.s)}`}>当たった人 {props.stats.hits} 人</a>
              <a href={`/admin/rules/${props.form.id}/runs${q(props.s)}`}>送った記録</a>
              {props.stats.pending > 0 ? <Badge tone="warn">待ち {props.stats.pending}</Badge> : null}
              {props.stats.failed > 0 ? <Badge tone="bad">失敗 {props.stats.failed}</Badge> : null}
            </div>
          ) : undefined
        }
      />
      <Flash msg={props.msg} />
      <Errors errors={props.errors} />
      <RuleSentence optionNames={props.choices.optionNames} trigger={trig} condition={cond.ok ? cond.condition : null} actions={acts} status={props.form.status} setName={setName} couponName={couponName} />
      <form method="post" action="/admin/rules/save">
        <Hidden s={props.s} />
        {props.form.id ? <input type="hidden" name="id" value={props.form.id} /> : null}
        <div class="layout">
          <div>
            <div class="card">
              <label for="name" style="margin-top:0">
                ルールの名前
              </label>
              <input type="text" id="name" name="name" maxlength={100} required value={props.form.name} placeholder="例: 秋の 3 点を揃えた人にお礼" style="max-width:none" />
            </div>
            <div class="card step">
              <div class="step-label">
                <span class="num">1</span>
                <h3>きっかけ</h3>
              </div>
              {TRIGGERS.map((t) => (
                <label class="check">
                  <input type="radio" name="trigger" value={t.value} checked={trig.kind === t.value} />
                  <span>{t.label}</span>
                </label>
              ))}
              <div class="row" style="margin:.25rem 0 0 1.6rem">
                <input type="number" id="trigger_days" name="trigger_days" min={1} max={730} value={f["trigger_days"] ?? ""} placeholder="例: 90" aria-label="きっかけの日数" />
                <span class="muted">日（「n 日たったとき」を選んだとき）</span>
              </div>
              {trig.kind === "checkout_abandoned" ? (
                <div class={props.choices.lastAbandonedAt ? "notice info small" : "notice warn small"} style="margin-left:1.6rem">
                  {props.choices.lastAbandonedAt ? (
                    <>カゴ落ちを最後に受け取ったのは {fmt(props.choices.lastAbandonedAt)} です。</>
                  ) : (
                    <>
                      手代はまだカゴ落ちを受け取っていません。前からつないでいる場合は、Banto の管理画面 → 連携 → 手代 で、受け取る出来事に <code>checkout.abandoned</code> を足して保存してください（受け取る出来事はつないだときに決まるため）。
                    </>
                  )}{" "}
                  当たったら 1 時間以上待ってから、レジを始めたあとに買っていなければ行います。文の {"{{product_name}}"}・{"{{product_url}}"} はカゴの最初の商品です。
                </div>
              ) : null}
              <fieldset style="margin:.5rem 0 0 1.6rem">
                <legend class="small">お気に入りのきっかけ</legend>
                <label class="check">
                  <input type="checkbox" name="exclude_bought" value="1" checked={!!f["exclude_bought"]} />
                  <span>その商品をもう買った会員は除く</span>
                </label>
                <p class="small" style="margin:.5rem 0 .25rem">見る単位（Banto の SKU のオプションと同じ）</p>
                {(
                  [
                    ["product", "商品ごと（商品の在庫の合計で見る。ほかのサイズ・色に在庫があるあいだは再入荷にならない）"],
                    ["axes", "オプションを選ぶ（例: カラーを選ぶと「赤のどれか」が戻ったら当たる）"],
                    ["sku", "SKU ごと（全部のオプションの組み合わせ。「赤 / M」が戻ったら当たる）"],
                  ] as const
                ).map(([value, label]) => (
                  <label class="check">
                    <input type="radio" name="variant_unit" value={value} checked={(f["variant_unit"] || "product") === value} />
                    <span>{label}</span>
                  </label>
                ))}
                <div class="row" style="margin-left:1.6rem">
                  {Object.keys(props.choices.optionNames ?? {}).length === 0 ? (
                    <span class="hint">オプションの名前は、手代がお気に入りの商品を読むと出ます（「SKU ごと」はいつでも選べます）。</span>
                  ) : (
                    Object.entries(props.choices.optionNames ?? {}).map(([key, name]) => (
                      <label class="check" style="margin:0 .75rem 0 0">
                        <input type="checkbox" name="variant_axes" value={key} checked={(f["variant_axes"] ?? "").split(",").includes(key)} />
                        <span>{name}</span>
                      </label>
                    ))
                  )}
                </div>
                <p class="hint">
                  当たりは会員 × 商品 × そのまとまりで 1 回です。お客様がどのサイズ・色を待っているかは分からないので、ふだんは「商品ごと」がおすすめです。文に {"{{variant}}"}（例「カラー: 赤」）を差し込めます。
                </p>
              </fieldset>
              <p class="hint">
                数えるのは会員の注文だけです（ゲスト・キャンセルは数えません）。「n 日たったとき」は 5 分ごとに見て、ルールが動いているあいだにちょうど n 日を過ぎた会員に当たります。お気に入りのきっかけは、その商品をお気に入りに入れている会員に、会員 × 商品で 1 回当たります（Banto のモジュール「会員のお気に入り」が要ります）。どちらも条件は無くてもかまいません。
              </p>
            </div>
            <div class="flow-arrow" aria-hidden="true">
              ↓
            </div>
            <ConditionStep f={f} sets={props.sets} s={props.s} />
            <div class="flow-arrow" aria-hidden="true">
              ↓
            </div>
            <ActionsStep s={props.s} f={f} choices={props.choices} />
          </div>
          <div class="side">
            <div class="card">
              <label for="status" style="margin-top:0">
                状態
              </label>
              <select id="status" name="status">
                {RULE_STATUSES.map((st) => (
                  <option value={st.value} selected={props.form.status === st.value}>
                    {st.label}
                  </option>
                ))}
              </select>
              <p class="hint">最初は「記録だけ」で当たる人を見てから「動かす」にするのがおすすめです。</p>
              {props.errors.length > 0 ? (
                <p class="notice bad small" role="alert" style="margin:.75rem 0 0">
                  保存していません。上の「直してください」の {props.errors.length} 件を直してから、もう一度押してください。
                </p>
              ) : null}
              <div class="row" style="margin-top:.85rem">
                <button name="op" value="save">
                  保存する
                </button>
                <button name="op" value="preview" class="secondary">
                  試しに当てる
                </button>
              </div>
            </div>
            {props.preview ? (
              <div class="card">
                <p style="margin-top:0">
                  <strong>今この条件に当たる会員: {props.preview.count.toLocaleString("ja-JP")} 人</strong>
                </p>
                {props.preview.sample.length > 0 ? (
                  <>
                    <p class="small muted" style="margin-bottom:.2rem">
                      見本（{props.preview.sample.length} 人）
                    </p>
                    <ul style="margin:0 0 .5rem;padding-left:1.1rem;font-size:.85rem">
                      {props.preview.sample.map((id) => (
                        <li>
                          <PersonLabel id={id} people={props.preview?.people} />
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p class="hint">
                  {trig.kind === "checkout_abandoned"
                    ? "手代が注文を記録している会員のうち、条件を満たす会員の数です（条件が無ければ全員）。当たるのは、この中でカゴ落ちした会員です。"
                    : isFavoriteTrigger(trig.kind)
                    ? "お気に入りに商品を入れている会員の数です。当たるのは、お気に入りの商品が再入荷・値下げ・残りわずかになったときに、その商品を入れている会員だけです。"
                    : isTimeTrigger(trig.kind)
                    ? `今もう ${trig.days ?? "n"} 日を過ぎている会員の数です。ルールはこれから「ちょうど ${trig.days ?? "n"} 日を過ぎた会員」に当たるので、この人たちには当たりません（届く人の目安にしてください）。`
                    : "手代が記録している購入だけで数えています。ルールは「この先の注文で条件に入った人」に当たるので、今当たる人に後から当たることはありません。"}
                </p>
                <MessageSample fields={f} shopName={props.choices.shopName} settings={props.choices.settings} />
              </div>
            ) : (
              <div class="card">
                <p class="small muted" style="margin:0">
                  「試しに当てる」で、今この条件に当たる会員の数と、文の見本を出します（保存はしません）。
                </p>
              </div>
            )}
          </div>
        </div>
      </form>
      {props.form.id ? (
        <div class="layout" style="margin-top:1rem">
          <div class="card">
            <h3>会員で確かめる</h3>
            <p class="hint">会員 ID を入れると、条件の部品ごとの今の値と、当たる・当たらない理由を出します。</p>
            <form method="get" action={`/admin/rules/${props.form.id}/check`} class="row" style="margin-top:.5rem">
              <Hidden s={props.s} />
              <input type="text" name="customer" maxlength={100} placeholder="会員 ID（Banto の会員の画面）" aria-label="会員 ID" />
              <button class="secondary">見る</button>
            </form>
          </div>
          <div class="card">
            <h3>このルールを消す</h3>
            <p class="hint">当たった記録と送った記録も消えます。</p>
            <form method="post" action={`/admin/rules/${props.form.id}/delete`} style="margin-top:.5rem">
              <Hidden s={props.s} />
              <button class="danger">消す</button>
            </form>
          </div>
        </div>
      ) : null}
    </AdminPage>
  );
}

export function HitsPage(props: { s: string; rule: Rule; total: number; items: Hit[]; people?: People }) {
  return (
    <AdminPage s={props.s} title={`${props.rule.name} の当たった会員`} current="rules">
      <PageHead
        title="当たった会員"
        lead={`${props.rule.name} ・ ${props.total.toLocaleString("ja-JP")} 人${props.total > props.items.length ? `（新しい ${props.items.length} 人）` : ""}`}
        back={{ href: `/admin/rules/${props.rule.id}${q(props.s)}`, label: props.rule.name }}
      />
      {props.items.length === 0 ? (
        <div class="card">
          <p class="muted">まだいません。</p>
        </div>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>会員</th>
                <th>きっかけの注文 ID</th>
              </tr>
            </thead>
            <tbody>
              {props.items.map((h) => (
                <tr>
                  <td class="nowrap">{fmt(h.hit_at)}</td>
                  <td>
                    <PersonLabel id={h.customer_id} people={props.people} />
                    <div class="id">{h.customer_id}</div>
                  </td>
                  <td>{h.order_id ? <span class="id">{h.order_id}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="hint">名前とメールの一部は、この画面を開いたときに Banto から読んでいます（新しい 20 人まで）。手代は会員の名前・メールアドレスを置きません。</p>
    </AdminPage>
  );
}

export interface RunView {
  rule_id?: string;
  rule_name?: string;
  customer_id: string;
  order_id: string | null;
  status: string;
  summary: string;
  attempts: number;
  last_error: string | null;
  updated_at: number;
  due_at: number;
}

const RUN_REASON: Record<string, string> = {
  quiet_hours: "夜なので朝まで待っています",
  customer_cap: "お客様ごとの上限なので、空くまで待っています",
  condition_lost: "待っているあいだに条件が崩れた（キャンセル・期間切れなど）",
  rule_stopped: "ルールを止めた",
  customer_gone: "会員がいない（退会）",
  bought_after: "カゴ落ちのあとに買っていた",
  favorite_removed: "お気に入りから外していた",
  sold_out: "売り切れていた",
  product_gone: "商品が無くなっていた（非公開・削除）",
};

function RunsTable(props: { s: string; items: RunView[]; people?: People; showRule?: boolean }) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>日時</th>
            {props.showRule ? <th>ルール</th> : null}
            <th>会員</th>
            <th>状態</th>
            <th>連絡</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((r) => (
            <tr>
              <td class="nowrap">{fmt(r.updated_at)}</td>
              {props.showRule ? <td>{r.rule_id ? <a href={`/admin/rules/${r.rule_id}${q(props.s)}`}>{r.rule_name}</a> : "—"}</td> : null}
              <td>
                <PersonLabel id={r.customer_id} people={props.people} />
              </td>
              <td>
                <RunBadge status={r.status} />
                {r.status === "pending" ? <div class="muted small">{fmt(r.due_at)} から</div> : null}
                {r.last_error ? (
                  <div class={r.status === "failed" ? "bad small" : "muted small"}>
                    {RUN_REASON[r.last_error] ?? r.last_error}
                    {r.status === "pending" && !RUN_REASON[r.last_error] ? `（${r.attempts} 回目の失敗。あとでやり直します）` : ""}
                  </div>
                ) : null}
              </td>
              <td>{r.summary || <span class="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const RUN_FILTERS = [
  { value: "", label: "すべて" },
  { value: "pending", label: "待ち" },
  { value: "failed", label: "失敗" },
  { value: "done", label: "済み" },
  { value: "skipped", label: "飛ばした" },
] as const;

/** すべてのルールの送った記録（状態とルールで絞る） */
export function AllRunsPage(props: { s: string; rules: Rule[]; status: string; ruleId: string; total: number; items: RunView[]; people?: People; counts: Record<string, number> }) {
  return (
    <AdminPage s={props.s} title="送った記録" current="runs">
      <PageHead title="送った記録" lead="「動かす」のルールが行ったアクションと、お客様への連絡の結果です。" />
      <div class="card">
        <form method="get" action="/admin/runs" class="row">
          <Hidden s={props.s} />
          <select name="status" aria-label="状態" style="max-width:12rem">
            {RUN_FILTERS.map((f) => (
              <option value={f.value} selected={props.status === f.value}>
                {f.label}
                {f.value && props.counts[f.value] ? `（${props.counts[f.value]}）` : ""}
              </option>
            ))}
          </select>
          <select name="rule" aria-label="ルール" style="max-width:20rem">
            <option value="">すべてのルール</option>
            {props.rules.map((r) => (
              <option value={r.id} selected={props.ruleId === r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button class="secondary">絞る</button>
        </form>
      </div>
      <p class="muted small">
        {props.total.toLocaleString("ja-JP")} 件{props.total > props.items.length ? `（新しい ${props.items.length} 件）` : ""}
      </p>
      {props.items.length === 0 ? (
        <div class="card">
          <p class="muted">ありません。</p>
        </div>
      ) : (
        <RunsTable s={props.s} items={props.items} people={props.people} showRule />
      )}
      <p class="hint">名前とメールの一部は、この画面を開いたときに Banto から読んでいます（新しい 20 人まで）。</p>
    </AdminPage>
  );
}

export function RunsPage(props: { s: string; rule: Rule; total: number; items: RunView[]; people?: People }) {
  return (
    <AdminPage s={props.s} title={`${props.rule.name} の送った記録`} current="rules">
      <PageHead
        title="送った記録"
        lead={`${props.rule.name} ・ ${props.total.toLocaleString("ja-JP")} 件${props.total > props.items.length ? `（新しい ${props.items.length} 件）` : ""}`}
        back={{ href: `/admin/rules/${props.rule.id}${q(props.s)}`, label: props.rule.name }}
      />
      {props.items.length === 0 ? (
        <div class="card">
          <p class="muted">まだありません（「動かす」のルールに当たった会員がここに並びます）。</p>
        </div>
      ) : (
        <RunsTable s={props.s} items={props.items} people={props.people} />
      )}
    </AdminPage>
  );
}

const ROLE_LABEL = { owner: "持ち主", member: "使える", pending: "開こうとした（許していない）" } as const;

/** この画面を使える人（持ち主が許す・外す） */
function AdminUsers(props: { s: string; users: { user_id: string; role: "owner" | "member" | "pending"; at: number }[]; me: string; isOwner: boolean }) {
  return (
    <div class="card">
      <h3>この画面を使える人</h3>
      <p class="hint">
        手代の画面は、手代をつないだ人の権限で Banto を読み書きします（会員の名前・クーポン・LINE・メール）。そのため、使えるのは持ち主（つないだ後に最初に画面を開いた人）と、持ち主が許した人だけです。ID は Banto の運営者の ID の頭 8 文字です（手代には名前が届きません）。つなぎ直しても持ち主は変わりません。持ち主を替えるときは、許した人に「持ち主を移す」を押します（移したあなたは「使える」になります）。
      </p>
      <table class="table">
        <tbody>
          {props.users.map((u) => (
            <tr>
              <td>
                <code>{u.user_id.slice(0, 8)}</code>
                {u.user_id === props.me ? <span class="muted small">（あなた）</span> : null}
              </td>
              <td>{ROLE_LABEL[u.role]}</td>
              <td class="small muted">{fmt(u.at)}</td>
              <td>
                {props.isOwner && u.role !== "owner" ? (
                  <div class="row">
                    {u.role === "pending" ? (
                      <form method="post" action="/admin/users/allow">
                        <Hidden s={props.s} />
                        <input type="hidden" name="user_id" value={u.user_id} />
                        <button class="secondary small">許す</button>
                      </form>
                    ) : null}
                    {u.role === "member" ? (
                      <form method="post" action="/admin/users/transfer">
                        <Hidden s={props.s} />
                        <input type="hidden" name="user_id" value={u.user_id} />
                        <button class="secondary small">持ち主を移す</button>
                      </form>
                    ) : null}
                    <form method="post" action="/admin/users/remove">
                      <Hidden s={props.s} />
                      <input type="hidden" name="user_id" value={u.user_id} />
                      <button class="secondary small">{u.role === "pending" ? "消す" : "外す"}</button>
                    </form>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!props.isOwner ? <p class="hint">許す・外すのは持ち主だけです。</p> : null}
    </div>
  );
}

export function SettingsPage(props: {
  s: string;
  settings: ShopSettings;
  errors: string[];
  mailTransport: string | null;
  mailProblems: string[];
  mailWarnings?: string[];
  slack: boolean;
  msg?: string;
  users?: { user_id: string; role: "owner" | "member" | "pending"; at: number }[];
  me?: string;
  isOwner?: boolean;
}) {
  const st = props.settings;
  return (
    <AdminPage s={props.s} title="設定" current="settings">
      <PageHead title="設定" lead="このショップの送り手・表示・連絡の歯止めです。" />
      <Flash msg={props.msg} />
      <Errors errors={props.errors} />
      <div class="card">
        <h3>送り手（Worker の変数）</h3>
        <dl class="kv" style="margin-top:.5rem">
          <dt>メール</dt>
          <dd>
            {props.mailTransport ? <Badge tone="ok">{props.mailTransport}</Badge> : <Badge>設定なし（LINE だけ使えます）</Badge>}
            {props.mailProblems.length > 0 ? <div class="bad small">形が違う・足りない変数: {props.mailProblems.join("、")}</div> : null}
            {(props.mailWarnings ?? []).map((w) => (
              <div class="bad small">{w}</div>
            ))}
          </dd>
          <dt>Slack</dt>
          <dd>{props.slack ? <Badge tone="ok">設定済み</Badge> : <Badge>設定なし（SLACK_WEBHOOK_URL）</Badge>}</dd>
        </dl>
      </div>
      <form method="post" action="/admin/settings">
        <Hidden s={props.s} />
        <div class="card">
          <h3>メールの送り手</h3>
          <label for="mail_from">送り手のアドレス</label>
          <input type="text" id="mail_from" name="mail_from" maxlength={200} value={st.mail_from} placeholder="店の名前 <news@shop.example>" readonly={!props.isOwner} />
          <p class="hint">送り手のサービス（Resend など）で確認済みのドメインのアドレスにします。{props.isOwner ? "" : "送り手・返信先・運営者への宛先を変えるのは持ち主だけです。"}</p>
          <label for="reply_to">返信先（任意）</label>
          <input type="text" id="reply_to" name="reply_to" maxlength={200} value={st.reply_to} readonly={!props.isOwner} />
        </div>
        <div class="card">
          <h3>メールの見た目（飾りありのメール）</h3>
          <p class="hint">ルールのメールを「飾りあり」にしたときのレイアウトに使います。</p>
          <label for="mail_accent">色（ボタン・上の線・見出しの線）</label>
          <input type="color" id="mail_accent" name="mail_accent" value={st.mail_accent} />
          <label for="mail_logo_url">ロゴの画像（https:// の URL、任意）</label>
          <input type="text" id="mail_logo_url" name="mail_logo_url" maxlength={1000} value={st.mail_logo_url} placeholder="https://shop.example.com/media/logo.png" />
          <p class="hint">高さ 40px で出します（横長の PNG がおすすめ）。無ければショップの名前を文字で出します。Banto の画像の URL が使えます。</p>
        </div>
        <div class="card">
          <h3>特定電子メール法の表示</h3>
          <p class="hint">宣伝のメールには、送信者の名前・住所・問い合わせ先と、配信を止める方法を書く決まりがあります。3 つとも入れるまで、メールのアクションは使えません。メールの最後に手代が付けます。</p>
          <label for="sender_name">送信者の名前</label>
          <input type="text" id="sender_name" name="sender_name" maxlength={100} value={st.sender_name} />
          <label for="sender_address">住所</label>
          <input type="text" id="sender_address" name="sender_address" maxlength={200} value={st.sender_address} />
          <label for="sender_contact">問い合わせ先（メールアドレスか URL・電話）</label>
          <input type="text" id="sender_contact" name="sender_contact" maxlength={200} value={st.sender_contact} />
        </div>
        <div class="card">
          <h3>お客様への連絡の歯止め</h3>
          <p class="hint">全ルールを合わせた、お客様ごとの LINE・メールの数です。超える連絡は空くまで後ろへずらし、7 日たっても空かなければ連絡だけ飛ばします。0 は上限なし。</p>
          <div class="inline-fields">
            <div>
              <label for="cap_day">1 日に（通まで）</label>
              <input type="number" id="cap_day" name="cap_day" min={0} max={10} value={String(st.cap_day)} />
            </div>
            <div>
              <label for="cap_week">7 日に（通まで）</label>
              <input type="number" id="cap_week" name="cap_week" min={0} max={50} value={String(st.cap_week)} />
            </div>
          </div>
          <p class="hint" style="margin-top:1rem">夜は送らずに朝まで待ちます（日本時間。始まりと終わりを同じにすると止めません）。</p>
          <div class="inline-fields">
            <div>
              <label for="quiet_start">送らない時間の始まり（時）</label>
              <input type="number" id="quiet_start" name="quiet_start" min={0} max={23} value={String(st.quiet_start)} />
            </div>
            <div>
              <label for="quiet_end">終わり（時）</label>
              <input type="number" id="quiet_end" name="quiet_end" min={0} max={23} value={String(st.quiet_end)} />
            </div>
          </div>
        </div>
        <div class="card">
          <h3>運営者への知らせ</h3>
          <label for="operator_email">知らせのメールの宛先</label>
          <input type="text" id="operator_email" name="operator_email" maxlength={200} value={st.operator_email} readonly={!props.isOwner} />
        </div>
        {props.errors.length > 0 ? (
          <p class="notice bad small" role="alert">
            保存していません。上の「直してください」の {props.errors.length} 件を直してから、もう一度押してください。
          </p>
        ) : null}
        <p>
          <button>保存する</button>
        </p>
      </form>
      <div class="card">
        <h3>試しに 1 通送る</h3>
        <p class="hint">保存済みの送り手のアドレスから、「運営者への知らせ」の宛先へ 1 通送ります。メールの送り手（Worker の変数）とアドレスが正しいかを、ルールを動かさずに確かめられます。</p>
        <form method="post" action="/admin/settings/test-mail" style="margin-top:.5rem">
          <Hidden s={props.s} />
          <button class="secondary" disabled={!props.mailTransport || !st.mail_from || !st.operator_email}>
            試しに送る
          </button>
          {!props.mailTransport || !st.mail_from || !st.operator_email ? <span class="muted small"> メールの送り手・送り手のアドレス・運営者の宛先がそろうと押せます。</span> : null}
        </form>
      </div>
      {props.users ? <AdminUsers s={props.s} users={props.users} me={props.me ?? ""} isOwner={!!props.isOwner} /> : null}
    </AdminPage>
  );
}

export function CheckPage(props: { s: string; rule: Rule; customerId: string; result: Explanation | null; error?: string; people?: People }) {
  const r = props.result;
  let steps: Steps = {};
  try {
    steps = r?.run ? (JSON.parse(r.run.steps) as Steps) : {};
  } catch {
    steps = {};
  }
  const tone = !r ? "" : r.hit ? "notice" : r.matchesNow ? "notice warn" : "notice info";
  return (
    <AdminPage s={props.s} title={`${props.rule.name} を会員で確かめる`} current="rules">
      <PageHead title="会員で確かめる" lead={props.rule.name} back={{ href: `/admin/rules/${props.rule.id}${q(props.s)}`, label: props.rule.name }} />
      <div class="card">
        <form method="get" action={`/admin/rules/${props.rule.id}/check`} class="row">
          <Hidden s={props.s} />
          <input type="text" name="customer" maxlength={100} value={props.customerId} placeholder="会員 ID（Banto の会員の画面）" aria-label="会員 ID" />
          <button class="secondary">見る</button>
        </form>
      </div>
      {props.error ? <p class="notice bad">{props.error}</p> : null}
      {r ? (
        <>
          <p class="muted" style="margin:0 0 .25rem">
            会員: <PersonLabel id={props.customerId} people={props.people} /> <span class="id">{props.customerId}</span>
          </p>
          <p class={tone}>{r.verdict}</p>
          {r.parts.length > 0 ? (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>条件</th>
                    <th>今</th>
                    <th>要る</th>
                  </tr>
                </thead>
                <tbody>
                  {r.parts.map((p) => (
                    <tr>
                      <td>{p.label}</td>
                      <td class="nowrap">
                        <Badge tone={p.ok ? "ok" : "bad"}>
                          {p.ok ? "✓" : "✗"} {p.have.toLocaleString("ja-JP")} {p.unit}
                        </Badge>
                      </td>
                      <td class="nowrap">
                        {p.need.toLocaleString("ja-JP")} {p.unit}以上
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div class="card" style="margin-top:1rem">
            <dl class="kv">
              <dt>手代の記録の注文</dt>
              <dd>{r.orders} 件（キャンセルを含む）</dd>
              <dt>当たった</dt>
              <dd>
                {r.hit ? (
                  <>
                    {fmt(r.hit.hit_at)} {r.hit.order_id ? <span class="id">（注文 {r.hit.order_id}）</span> : null}
                  </>
                ) : (
                  <span class="muted">まだ</span>
                )}
              </dd>
              <dt>アクション</dt>
              <dd>
                {r.run ? (
                  <>
                    <RunBadge status={r.run.status} />
                    {r.run.status === "pending" ? <span class="muted small"> {fmt(r.run.due_at)} から</span> : null}
                    {r.run.last_error ? <span class="muted small"> — {RUN_REASON[r.run.last_error] ?? r.run.last_error}</span> : null}
                    {messageSummary(steps) ? <span class="small"> — {messageSummary(steps)}</span> : null}
                  </>
                ) : (
                  <span class="muted">—</span>
                )}
              </dd>
            </dl>
          </div>
        </>
      ) : null}
    </AdminPage>
  );
}
