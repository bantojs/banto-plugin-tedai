/** @jsxImportSource hono/jsx */
/**
 * 注文のお知らせ（取引の知らせ、src/notices/）の画面: 一覧・準備の確かめ・文面の編集と見本・送った記録。
 * お店で試着のお知らせ（お客様あて）も同じ画面で扱う（種類の組が違うだけ）。
 */
import { NOTICE_KINDS, REQUIRED, EVENTS_FOR, noticeGroup, noticeLabel, placeholdersFor, slotsFor, type NoticeGroup, type NoticeKind, type NoticeTemplate } from "../notices/kinds";
import { NOTICE_RESULTS, sampleNotice } from "../notices/send";
import type { NoticeSendRow } from "../store/notices";
import type { ShopSettings } from "../store/settings";
import { Errors, Flash, Hidden, q } from "./pages";
import { AdminPage, Badge, PageHead, ShortId, fmt } from "./views";

export interface NoticeReadiness {
  mailTransport: boolean;
  mailFrom: boolean;
  pii: boolean;
}

export const noticeReady = (r: NoticeReadiness) => r.mailTransport && r.mailFrom && r.pii;

function Readiness(props: { s: string; r: NoticeReadiness }) {
  const r = props.r;
  if (noticeReady(r)) return null;
  return (
    <div class="notice warn">
      <strong>送る前に</strong>
      <ul style="margin:.35rem 0 0;padding-left:1.25rem">
        {!r.mailTransport ? <li>メールの送り手がありません（Worker の変数 MAIL_TRANSPORT ほか。README の「メール」）。</li> : null}
        {!r.mailFrom ? (
          <li>
            <a href={`/admin/settings${q(props.s)}`}>設定</a>で送り手のアドレスを入れてください。
          </li>
        ) : null}
        {!r.pii ? (
          <li>
            このつなぎ方には、注文の宛先を読む権限（<code>orders:contact</code>）がありません。Banto を 0173 の入った版に上げてから、Banto の管理画面 → 連携 → 手代 で<strong>つなぎ直して</strong>ください（前の版の手代でつないだショップ・古い Banto）。
          </li>
        ) : null}
      </ul>
    </div>
  );
}

const STATUS_BADGE: Record<string, { tone?: "ok" | "bad" | "warn" | "info"; label: string }> = {
  pending: { tone: "info", label: "送る前" },
  done: { tone: "ok", label: "送った" },
  skipped: { label: "送らなかった" },
  failed: { tone: "bad", label: "失敗" },
};

function KindTable(props: { s: string; templates: NoticeTemplate[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>種類</th>
          <th>送るとき</th>
          <th>状態</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.templates.map((t) => {
          const k = NOTICE_KINDS.find((x) => x.kind === t.kind)!;
          return (
            <tr>
              <td>
                <strong>{k.label}</strong>
              </td>
              <td class="small muted">{k.when}</td>
              <td>
                {t.enabled ? <Badge tone="ok">手代が送る</Badge> : <Badge>送らない</Badge>}
                {t.format === "html" ? <span class="small muted"> 飾りあり</span> : null}
              </td>
              <td>
                <a href={`/admin/notices/${t.kind}${q(props.s)}`}>文面</a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ofGroup = (ts: NoticeTemplate[], g: NoticeGroup) => ts.filter((t) => noticeGroup(t.kind) === g);

export function NoticesPage(props: { s: string; templates: NoticeTemplate[]; ready: NoticeReadiness; recent: NoticeSendRow[]; onlyFailed?: boolean; failed: number; msg?: string }) {
  const on = props.templates.filter((t) => t.enabled);
  return (
    <AdminPage s={props.s} title="注文のお知らせ" current="notices">
      <PageHead title="注文のお知らせ" lead="ご注文の受付・発送と、お店で試着の受付・取り置きなどのメールを、Banto の代わりに手代がお客様（会員もゲストも）に送ります。" />
      <Flash msg={props.msg} />
      <Readiness s={props.s} r={props.ready} />
      <div class="card">
        <h3>切り替えの手順（注文）</h3>
        <ol class="small" style="margin:.35rem 0 0;padding-left:1.25rem;line-height:1.8">
          <li>下の種類ごとに文面を整え、「手代が送る」にして保存します。</li>
          <li>
            Banto の管理画面 → 連携 → 手代 の「購読する出来事」に、送る種類の出来事を入れます（受付: <code>order.paid</code>・<code>order.created</code>、発送: <code>order.shipped</code>、キャンセル: <code>order.cancelled</code>）。
          </li>
          <li>
            Banto の管理画面 → プラグイン → 同梱の「メール通知」で、<strong>「注文のメールを送らない（外部プラグインに任せる）」</strong>に印を付けます（Banto 0172 から）。付けないと、お客様に同じ知らせが 2 通届きます。
          </li>
        </ol>
        <div class="notice warn small" style="margin-top:.75rem">
          <strong>「メール通知」を OFF にはしないでください</strong>: 会員のログインのコード・組織への招待・お問い合わせなどのメールは、「メール通知」の送信元で送っています。止めるのは「注文のメールを送らない」の印だけです。
          この印を付けると、Banto からの<strong>運営者への注文の控えも止まります</strong>。新しい注文を知りたいときは、Banto の同梱の「LINE 通知」を ON にしてください。
          Banto が 0172 より前の版なら、この印がありません。上げるまで「手代が送る」にしないでください。
        </div>
        <p class="hint">
          注文のお知らせは宣伝ではないので、案内メールの同意が無いお客様にも送り、お客様ごとの上限・夜は送らない時間・配信停止のリンクは使いません。<strong>文面に宣伝（セール・おすすめの商品など）を入れないでください</strong>（入れると特定電子メール法の広告メールになります。宣伝は「ルール」で）。
        </p>
      </div>
      <div class="card">
        <h3>注文</h3>
        <KindTable s={props.s} templates={ofGroup(props.templates, "order")} />
      </div>
      <div class="card">
        <h3>お店で試着（お客様あて）</h3>
        <KindTable s={props.s} templates={ofGroup(props.templates, "tryon")} />
        <ol class="small" style="margin:.75rem 0 0;padding-left:1.25rem;line-height:1.8">
          <li>
            Banto の管理画面 → 連携 → 手代 の「購読する出来事」に <code>tryon.requested</code>・<code>tryon.updated</code> を入れます（この版より前からつないでいるショップは、選び直すかつなぎ直します）。
          </li>
          <li>
            Banto の管理画面 → プラグイン → 同梱の「メール通知」で、<strong>「お店で試着のお客様あてのお知らせを送らない」</strong>に印を付けます。付けないと、お客様に同じ知らせが 2 通届きます。
          </li>
          <li>店舗あての知らせ（申し込みがありました・延長がありました）は、今までどおり Banto が送ります（店舗のアドレスは手代に渡りません）。</li>
          <li>
            店舗の住所・営業時間を載せるには、店舗を読む権限（<code>shop:read</code>）が要ります。この版より前からつないでいるショップは、つなぎ直してください（無いあいだは店舗の名前だけを載せます）。
          </li>
        </ol>
        <p class="hint">LINE のお知らせは今までどおり Banto が送ります（手代が引き受けるのはメールだけです）。</p>
      </div>
      <div class="card">
        <h3>お支払いのお願い（KOMOJU）</h3>
        <KindTable s={props.s} templates={ofGroup(props.templates, "payment")} />
        <ol class="small" style="margin:.75rem 0 0;padding-left:1.25rem;line-height:1.8">
          <li>
            Banto を <strong>0182 の入った版</strong>に上げ、Banto の管理画面 → ショップの設定 → お知らせの文面 で<strong>「お支払いのお願いを送る」を ON</strong> にします（OFF のあいだは Banto が知らせを出さないので、手代も送りません）。
          </li>
          <li>
            Banto の管理画面 → 連携 → 手代 の「購読する出来事」に <code>checkout.payment_pending</code> を入れます（この版より前からつないでいるショップは、選び直すかつなぎ直します）。
          </li>
          <li>
            Banto の「メール通知」で「注文のメールを送らない（外部プラグインに任せる）」に印を付けているショップは、Banto からはお支払いのお願いのメールが出ません。印を付けていないショップで手代も送ると、2 通届きます。
          </li>
        </ol>
        <p class="hint">
          リンク（{"{{payment_link}}"}）を開くと、お客様はお支払いに進むか、お申し込みを取りやめられます。リンクは宛先と同じく、つないだときに <code>orders:contact</code> を許したつなぎ方にだけ Banto が渡します。もう払った・取りやめた・期限が切れたお申し込みには送りません。
        </p>
      </div>
      {on.length > 0 ? (
        <p class="hint">
          手代が送る種類: {on.map((t) => noticeLabel(t.kind)).join("・")}。Banto の同梱の「メール通知」と重なっていないか、確かめてください。
        </p>
      ) : null}
      <h2 style="margin-top:1.5rem">{props.onlyFailed ? "失敗した知らせ（新しい 50 件）" : "送った記録（新しい 50 件）"}</h2>
      <p class="small">
        {props.onlyFailed ? <a href={`/admin/notices${q(props.s)}`}>すべて</a> : <a href={`/admin/notices${q(props.s)}&status=failed`}>失敗だけ</a>}
      </p>
      {props.failed > 0 ? (
        <div class="notice warn small">
          7 日以内に受け取った知らせのうち、{props.failed} 件が失敗しています。送り手の設定（キー・送り元のドメイン）を直したら、まとめて送り直せます。
          <form method="post" action="/admin/notices/retry-failed" style="margin-top:.5rem">
            <Hidden s={props.s} />
            <button class="secondary small">失敗した {props.failed} 件をまとめて送り直す</button>
          </form>
        </div>
      ) : null}
      {props.recent.length === 0 ? (
        <div class="card">
          <p class="muted">まだありません。</p>
        </div>
      ) : (
        <div class="card">
          <table class="table">
            <thead>
              <tr>
                <th>受け取った時刻</th>
                <th>注文・申し込み</th>
                <th>種類</th>
                <th>状態</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>
              {props.recent.map((r) => {
                const b = STATUS_BADGE[r.status] ?? { label: r.status };
                return (
                  <tr>
                    <td class="small">{fmt(r.created_at)}</td>
                    <td>{r.order_number ? (noticeGroup(r.kind) === "tryon" ? `受付 #${r.order_number}` : `#${r.order_number}`) : <ShortId id={r.order_id} />}</td>
                    <td>{noticeLabel(r.kind)}</td>
                    <td>
                      <Badge tone={b.tone}>{b.label}</Badge>
                    </td>
                    <td class="small">
                      {r.result ? (NOTICE_RESULTS[r.result] ?? r.result) : r.attempts > 0 ? `やり直し待ち（${r.attempts} 回目まで失敗）` : ""}
                      {r.last_error ? <div class="muted">{r.last_error}</div> : null}
                      {r.status === "failed" ? (
                        <form method="post" action="/admin/notices/retry" style="margin-top:.25rem">
                          <Hidden s={props.s} />
                          <input type="hidden" name="order_id" value={r.order_id} />
                          <input type="hidden" name="kind" value={r.kind} />
                          <button class="secondary small">送り直す</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p class="hint">記録に置くのは注文 ID・番号・種類・時刻と結果だけです（宛先とお名前は送る直前に Banto から読み、置きません）。90 日で消します。</p>
    </AdminPage>
  );
}

const PLACEHOLDER_HELP: Record<NoticeGroup, string> = {
  order: "お名前・ショップ・注文番号・合計・ご注文の確認ページ・お支払い方法・問い合わせ先・明細・発送のお問い合わせ番号",
  tryon: "お名前・ショップ・受付番号・店舗の名前・取り置きの期限・来店予定日の行（受付だけ）・問い合わせ先・お店のトップ・品目・店舗の案内（住所・電話・営業時間・近い臨時休業）",
  payment: "お名前・ショップ・お支払い金額・お支払いの期限・支払いの種類・お支払いに進む・取りやめる画面のリンク・問い合わせ先・品目と合計",
};

export function NoticeEditPage(props: { s: string; template: NoticeTemplate; settings: ShopSettings; shopName: string; shopSlug: string; bantoOrigin: string; now: number; storeRead: boolean; ready: NoticeReadiness; errors: string[]; msg?: string }) {
  const t = props.template;
  const k = NOTICE_KINDS.find((x) => x.kind === t.kind)!;
  const group = k.group;
  const sample = sampleNotice(t, { shopName: props.shopName, shopSlug: props.shopSlug, bantoOrigin: props.bantoOrigin, settings: props.settings, now: props.now });
  const required = REQUIRED[t.kind];
  const slots = slotsFor(t.kind);
  return (
    <AdminPage s={props.s} title={`${k.label}のお知らせ`} current="notices">
      <PageHead title={`${k.label}のお知らせ`} lead={`送るとき: ${k.when}`} back={{ href: `/admin/notices${q(props.s)}`, label: "注文のお知らせ" }} />
      <Flash msg={props.msg} />
      <Errors errors={props.errors} />
      <Readiness s={props.s} r={props.ready} />
      <form method="post" action="/admin/notices/save">
        <Hidden s={props.s} />
        <input type="hidden" name="kind" value={t.kind} />
        <div class="card">
          <label class="check">
            <input type="checkbox" name="enabled" value="1" checked={t.enabled} /> 手代が送る
          </label>
          <p class="hint">
            Banto から <code>{EVENTS_FOR[t.kind].join("・")}</code> を受け取ったときに送ります。Banto の同梱の「メール通知」と重ならないよう、<a href={`/admin/notices${q(props.s)}`}>切り替えの手順</a>を確かめてください。
          </p>
          <label for="subject">件名</label>
          <input type="text" id="subject" name="subject" maxlength={150} value={t.subject} />
          <label for="format">形</label>
          <select id="format" name="format">
            <option value="text" selected={t.format === "text"}>
              文字だけ
            </option>
            <option value="html" selected={t.format === "html"}>
              飾りあり（HTML）
            </option>
          </select>
          <label for="body">本文</label>
          <textarea id="body" name="body" maxlength={5000} style="min-height:16rem">
            {t.body}
          </textarea>
          <p class="hint">
            差し込み: {[...placeholdersFor(t.kind), ...slots].map((p) => <code style="margin-right:.25rem">{`{{${p}}}`}</code>)}
            （{PLACEHOLDER_HELP[group]}）。
            {required.length > 0 ? (
              <>
                {" "}
                この知らせには {required.map((r) => <code style="margin-right:.25rem">{`{{${r}}}`}</code>)}を必ず入れます。
              </>
            ) : null}
            {slots.map((p) => <code style="margin-right:.25rem">{`{{${p}}}`}</code>)}は 1 行に単独で書きます。飾りありの書き方はルールのメールと同じです（見出し・太字・リンク・ボタン・画像）。
          </p>
          {group === "tryon" && !props.storeRead ? (
            <div class="notice warn small">
              このつなぎ方には店舗を読む権限（<code>shop:read</code>）がありません。店舗の案内（{"{{store_info}}"}）には店舗の名前だけが入ります。住所・営業時間を載せるには、Banto の管理画面 → 連携 → 手代 でつなぎ直してください。
            </div>
          ) : null}
          <p class="hint">
            「試しに送る」は、いま画面にある文面（保存はしません）を見本の{group === "tryon" ? "申し込み" : group === "payment" ? "お申し込み（未払い）" : "注文"}で作り、
            {props.settings.operator_email ? <strong>{props.settings.operator_email}</strong> : <a href={`/admin/settings${q(props.s)}`}>設定の「運営者への知らせ」の宛先</a>}
            に 1 通送ります（お客様には送りません。件名の頭に [試し送り]）。
          </p>
          {group === "order" ? (
            <p class="hint">ご注文の確認ページ（{"{{order_url}}"}）は Banto の注文照会です。ゲストは注文番号が入った状態で開き、メールアドレスを入れて確かめます。発送の追跡番号もここに出ます。</p>
          ) : group === "tryon" ? (
            <p class="hint">お店のトップ（{"{{shop_url}}"}）はボタンやリンクの先に使えます。お申し込みの確認・延長は、会員のお客様なら Banto の会員ページでできます。</p>
          ) : (
            <p class="hint">
              お支払いのリンク（{"{{payment_link}}"}）は必ず入れます。ボタンの先（{"[[お支払いに進む]]({{payment_link}})"}）にも使えます。期限（{"{{pay_until}}"}）は Banto の運営者の時間帯の「11月28日（土）15:00」の形です。
            </p>
          )}
          <div class="row" style="margin-top:1rem">
            <button name="op" value="save">
              保存する
            </button>
            <button name="op" value="preview" class="secondary">
              見本を出し直す
            </button>
            <button name="op" value="test" class="secondary">
              試しに送る
            </button>
            <button name="op" value="reset" class="secondary">
              既定の文面に戻す
            </button>
          </div>
        </div>
      </form>
      <h2 style="margin-top:1.5rem">見本</h2>
      <p class="small muted">
        {group === "tryon" ? "見本の申し込み（受付番号 2001・2 品・渋谷店）" : group === "payment" ? "見本のお申し込み（コンビニ払い・1 品・¥9,400）" : "見本の注文（番号 1001・2 品・値引きと送料あり）"}で作っています。件名: {sample.subject}
      </p>
      {sample.html ? (
        <iframe class="mail-preview" title="メールの見本" sandbox="" srcdoc={sample.html} />
      ) : null}
      <details open={!sample.html}>
        <summary class="small">文字だけの版</summary>
        <pre class="sample">{sample.text}</pre>
      </details>
    </AdminPage>
  );
}

export const kindParam = (v: string | undefined): NoticeKind | null => (v && NOTICE_KINDS.some((k) => k.kind === v) ? (v as NoticeKind) : null);
