/**
 * メールの文面を RFC 5322 / MIME の形にする（SMTP の送り手が使う）。Banto（MIT）の src/mail/message.ts を元に、
 * 配信停止のヘッダ（List-Unsubscribe、RFC 8058 のワンクリック）を足せるようにした。
 * HTML があれば multipart/alternative（文字だけの版を先、HTML を後。読めるアプリは後ろを選ぶ）。
 */
export interface MailAddress {
  name?: string;
  email: string;
}

/** アドレスの形（空白・改行・< > , ; " ( ) を含まない。SMTP のコマンドとヘッダに出すので厳しく） */
const EMAIL_RE = /^[^\s<>@,;"()\\]+@[^\s<>@,;"()\\]+\.[^\s<>@,;"()\\]+$/;

export class MailAddressError extends Error {
  constructor(raw: string) {
    super(`invalid mail address: ${raw.replace(/[\r\n\t]/g, " ").slice(0, 60)}`);
    this.name = "MailAddressError";
  }
}

export const isEmail = (s: string) => EMAIL_RE.test(s);

/** "名前 <a@b>" / "<a@b>" / "a@b" を分ける。アドレスの形でなければ MailAddressError */
export function parseAddress(raw: string): MailAddress {
  const s = raw.trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (!m) {
    const email = s.replace(/^<|>$/g, "");
    if (!EMAIL_RE.test(email)) throw new MailAddressError(email);
    return { email };
  }
  if (!EMAIL_RE.test(m[2]!)) throw new MailAddressError(m[2]!);
  let name = m[1]!.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  // 表示名に < > @ を入れさせない（「info@別の店 <自分の店>」のような見せかけと、送り手のサービスとの読み違いを防ぐ）
  if (/[\r\n<>@]/.test(name)) throw new MailAddressError(name);
  return name ? { name, email: m[2]! } : { email: m[2]! };
}

const enc = new TextEncoder();

export function base64Utf8(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const base64Body = (s: string) => base64Utf8(s).replace(/.{76}/g, "$&\r\n").replace(/\r\n$/, "");

const WORD_BYTES = 45;

export function encodeHeaderText(s: string, opts: { phrase?: boolean } = {}): string {
  if (/^[\x20-\x7e]*$/.test(s)) {
    if (opts.phrase && /[^A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]/.test(s)) return `"${s.replace(/["\\]/g, "\\$&")}"`;
    return s;
  }
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (bytes + n > WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
  return words.join("\r\n ");
}

export const formatAddress = (a: MailAddress) => (a.name ? `${encodeHeaderText(a.name, { phrase: true })} <${a.email}>` : a.email);

export interface Mail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  /** 飾りのある版（src/mail/html.ts が作る）。あれば文字だけの版と両方を入れる */
  html?: string;
  /** 配信停止の URL（https）。List-Unsubscribe と List-Unsubscribe-Post を付ける */
  unsubscribeUrl?: string;
  /** どのショップのメールか（MAIL_FROM_DOMAINS のショップごとの決まりに使う。URL の名前と ID） */
  shop?: { slug: string; id: string };
  /** 同じメールを二度送らないための鍵（受け付ける送り手だけが使う） */
  idempotencyKey?: string;
}

export function buildMimeMessage(m: Mail, opts: { now?: Date; messageId?: string } = {}): { envelopeFrom: string; recipients: string[]; data: string } {
  const from = parseAddress(m.from);
  const to = parseAddress(m.to);
  if (m.unsubscribeUrl && (/[\r\n<>]/.test(m.unsubscribeUrl) || !m.unsubscribeUrl.startsWith("https://"))) throw new Error("invalid unsubscribe url");
  const domain = from.email.split("@")[1] || "tedai.invalid";
  const id = opts.messageId ?? `${crypto.randomUUID()}@${domain}`;
  const headers: string[] = [
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    ...(m.replyTo ? [`Reply-To: ${formatAddress(parseAddress(m.replyTo))}`] : []),
    `Subject: ${encodeHeaderText(m.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${(opts.now ?? new Date()).toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${id}>`,
    ...(m.unsubscribeUrl ? [`List-Unsubscribe: <${m.unsubscribeUrl}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    "MIME-Version: 1.0",
  ];
  const part = (type: string, body: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Body(body)}\r\n`;
  if (!m.html) return { envelopeFrom: from.email, recipients: [to.email], data: `${headers.join("\r\n")}\r\n${part("text/plain", m.text)}` };
  // base64 の本文には = と - の並びが出ないので、この区切りは中身とぶつからない
  const boundary = `=_tedai_${crypto.randomUUID().replace(/-/g, "")}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const data = `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\n${part("text/plain", m.text)}--${boundary}\r\n${part("text/html", m.html)}--${boundary}--\r\n`;
  return { envelopeFrom: from.email, recipients: [to.email], data };
}
