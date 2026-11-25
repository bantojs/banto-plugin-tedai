/**
 * 案内メールの送り手（手代の持ち物。Banto の MAIL_TRANSPORT は使わない: ログインと注文のメールの評判を守るため）。
 * 変数 MAIL_TRANSPORT で 1 つ選ぶ: resend（RESEND_API_KEY）/ smtp（SMTP_HOST ほか）。SendGrid・SES は後で足せる継ぎ目。
 */
import { BudgetExceeded } from "../budget";
import { buildMimeMessage, parseAddress, type Mail } from "./message";

/** 確かめた形の "名前 <アドレス>"（JSON で渡す送り手向け。名前は UTF-8 のまま、記号があるときだけ引用符で囲む） */
function plainAddress(raw: string): string {
  const a = parseAddress(raw);
  if (!a.name) return a.email;
  const name = /[",;:()\\[\]]/.test(a.name) ? `"${a.name.replace(/["\\]/g, "\\$&")}"` : a.name;
  return `${name} <${a.email}>`;
}
import { SmtpError, SmtpMaybeSent, smtpSend } from "./smtp-client";
import type { SocketAdapter } from "./socket";

/** 送れたかもしれない（SMTP で本文を送った後に応答が無いまま終わった）。やり直すと 2 通になりうるので、呼ぶ側はやり直さない */
export class MailMaybeSent extends Error {
  readonly status = 0;
  constructor(message: string) {
    super(message);
    this.name = "MailMaybeSent";
  }
}

/** SMTP で 1 通を送り終えるまでの上限 */
export const SMTP_DEADLINE_MS = 60_000;

export class MailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MailError";
  }
}

export interface Mailer {
  readonly name: "resend" | "smtp";
  send(mail: Mail): Promise<void>;
}

/**
 * fromDomains: 送り手のアドレスに使ってよいドメイン（変数 MAIL_FROM_DOMAINS、カンマ区切り）。無ければ縛らない。
 * `ショップの URL の名前=ドメイン` と書いたものはそのショップだけ、ドメインだけのものはどのショップでも使える
 */
export type FromDomain = { by: "id" | "slug" | null; shop: string | null; domain: string };
export type MailConfig = (
  | { transport: "resend"; apiKey: string }
  | { transport: "smtp"; host: string; port: number; tls: "on" | "starttls" | "off"; user?: string; pass?: string }
) & { fromDomains?: FromDomain[] };

/** メールのショップ（MAIL_FROM_DOMAINS のショップごとの決まりは、URL の名前かショップの ID で書ける） */
export type MailShop = { slug: string; id: string };

/** そのショップで使ってよいドメイン（ショップを決めないなら、どのショップでも使えるものだけ） */
/** ID の形（UUID）の URL の名前は、URL の名前の決まりに当てない（別のショップの ID を URL の名前にして、そのショップのドメインを使えないように） */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const domainsFor = (cfg: Pick<MailConfig, "fromDomains">, shop?: MailShop) =>
  (cfg.fromDomains ?? [])
    .filter((d) => {
      if (d.by === null) return true;
      if (!shop) return false;
      if (d.by === "id") return d.shop === shop.id.toLowerCase();
      const slug = shop.slug.toLowerCase();
      return !UUID_LIKE.test(slug) && d.shop === slug;
    })
    .map((d) => d.domain);

/** 送り手のアドレスのドメインが、そのショップに許したドメイン（とそのサブドメイン）か */
export function fromAllowed(cfg: Pick<MailConfig, "fromDomains">, from: string, shop?: MailShop): boolean {
  if (!cfg.fromDomains || cfg.fromDomains.length === 0) return true;
  const list = domainsFor(cfg, shop);
  let domain: string;
  try {
    domain = parseAddress(from).email.split("@")[1]!.toLowerCase();
  } catch {
    return false;
  }
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** 変数から読む。設定が無ければ null、形が違えば足りない名前 */
export function readMailConfig(env: Record<string, unknown>): { config: MailConfig | null; problems: string[] } {
  const s = (k: string) => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
  const t = s("MAIL_TRANSPORT");
  if (!t) return { config: null, problems: [] };
  // `id:<ショップの ID>=ドメイン`・`slug:<URL の名前>=ドメイン`（`<名前>=ドメイン` も URL の名前）・`ドメイン`（どのショップでも）
  const domains: FromDomain[] = s("MAIL_FROM_DOMAINS")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .map((d): FromDomain => {
      const eq = d.indexOf("=");
      if (eq <= 0) return { by: null, shop: null, domain: d };
      const key = d.slice(0, eq).trim();
      const domain = d.slice(eq + 1).trim();
      if (key.startsWith("id:")) return { by: "id", shop: key.slice(3), domain };
      return { by: "slug", shop: key.startsWith("slug:") ? key.slice(5) : key, domain };
    });
  if (domains.some((d) => !/^[a-z0-9.-]{1,253}$/.test(d.domain) || (d.shop !== null && !/^[a-z0-9_-]{1,100}$/.test(d.shop)))) return { config: null, problems: ["MAIL_FROM_DOMAINS"] };
  const extra = domains.length > 0 ? { fromDomains: domains } : {};
  if (t === "resend") return s("RESEND_API_KEY") ? { config: { transport: "resend", apiKey: s("RESEND_API_KEY"), ...extra }, problems: [] } : { config: null, problems: ["RESEND_API_KEY"] };
  if (t === "smtp") {
    const host = s("SMTP_HOST");
    const port = Number(s("SMTP_PORT") || "587");
    const tlsRaw = s("SMTP_TLS") || (port === 465 ? "on" : "starttls");
    const problems: string[] = [];
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) problems.push("SMTP_HOST");
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 25) problems.push("SMTP_PORT");
    // off（暗号化しない）は受け付けない: Worker からの SMTP はインターネットを通るので、お客様のアドレス・お名前と SMTP の認証が平文で流れる
    if (tlsRaw !== "on" && tlsRaw !== "starttls") problems.push("SMTP_TLS");
    if (problems.length > 0) return { config: null, problems };
    return { config: { transport: "smtp", host, port, tls: tlsRaw as "on" | "starttls", user: s("SMTP_USER") || undefined, pass: s("SMTP_PASS") || undefined, ...extra }, problems: [] };
  }
  return { config: null, problems: ["MAIL_TRANSPORT"] };
}

export function mailer(cfg: MailConfig, deps: { fetch: typeof fetch; sockets?: SocketAdapter; ehloName: string }): Mailer {
  const inner = rawMailer(cfg, deps);
  return {
    name: inner.name,
    async send(mail) {
      // 同じ手代につないだほかのショップの送り元を名乗らせない（運営者が MAIL_FROM_DOMAINS で決める）
      if (!fromAllowed(cfg, mail.from, mail.shop)) throw new MailError(403, "from_not_allowed");
      await inner.send(mail);
    },
  };
}

function rawMailer(cfg: MailConfig, deps: { fetch: typeof fetch; sockets?: SocketAdapter; ehloName: string }): Mailer {
  if (cfg.transport === "resend") {
    return {
      name: "resend",
      async send(mail) {
        // 形を確かめる（SMTP と同じ決まり）
        buildMimeMessage(mail);
        const f = deps.fetch;
        let res: Response;
        try {
          res = await f("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}`, ...(mail.idempotencyKey ? { "Idempotency-Key": mail.idempotencyKey } : {}) },
            body: JSON.stringify({
              // 確かめた形のまま渡す（送り手のサービスが元の文字を別に読み違えないように）
              from: plainAddress(mail.from),
              to: [mail.to],
              ...(mail.replyTo ? { reply_to: plainAddress(mail.replyTo) } : {}),
              subject: mail.subject,
              text: mail.text,
              ...(mail.html ? { html: mail.html } : {}),
              ...(mail.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${mail.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
            }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch (e) {
          // Cron の上限の手前で止めた（src/budget.ts）は包まない（呼ぶ側が済んだ手順を残して次の回に回す）
          if (e instanceof BudgetExceeded) throw e;
          throw new MailError(0, `Resend: ${(e as Error).message}`);
        }
        if (!res.ok) throw new MailError(res.status, `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      },
    };
  }
  return {
    name: "smtp",
    async send(mail) {
      if (!deps.sockets) throw new MailError(0, "SMTP: sockets unavailable");
      const msg = buildMimeMessage(mail);
      try {
        // 1 つの応答は 15 秒、1 通の全体は 60 秒で打ち切る（接続を閉じて止める。遅い送り手で行の持ち時間を越えないように）
        await smtpSend(deps.sockets, { host: cfg.host, port: cfg.port, tls: cfg.tls, user: cfg.user, pass: cfg.pass, ehloName: deps.ehloName, timeoutMs: 15_000, deadlineMs: SMTP_DEADLINE_MS }, {
          from: msg.envelopeFrom,
          recipients: msg.recipients,
          data: msg.data,
        });
      } catch (e) {
        if (e instanceof BudgetExceeded) throw e;
        if (e instanceof SmtpMaybeSent) throw new MailMaybeSent(`SMTP ${e.message}`);
        if (e instanceof SmtpError) throw new MailError(e.code, `SMTP ${e.message}`);
        throw new MailError(0, `SMTP: ${(e as Error).message}`);
      }
    },
  };
}

/** エラーの文からメールアドレスを消す（SMTP の応答や形の誤りはお客様のアドレスを含むことがある。記録・ログに残さない） */
export const redactAddresses = (s: string) => s.replace(/\S*@\S+/g, "<address>");

/**
 * やり直しても同じ結果になる、宛先やメールの中身への断り。
 * 送り手の設定の誤り（Resend の 401・403 = キーや送り元のドメイン、SMTP の 530・534・535・538 = 認証）は、
 * 運営者が直せば通るので、ここに入れない（やり直しの間に直してもらう）
 */
export function permanentMailError(transport: Mailer["name"], status: number): boolean {
  if (transport === "smtp") return status >= 500 && status < 600 && ![530, 534, 535, 538].includes(status);
  return [400, 409, 422].includes(status);
}
