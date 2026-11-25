/**
 * 飾りのあるメール（HTML）。運営者は生の HTML を書かず、決まった書き方（Markdown の一部）で本文を書く。
 * 手代がそれを決まったレイアウト（表組み・インラインの style、メールのアプリで崩れにくい形）に流し込み、
 * 同じ本文から文字だけの版も作る（multipart/alternative の両方に入れる）。
 *
 * 書き方（行ごと）:
 *   # 見出し / ## 小見出し
 *   - 箇条書き
 *   ---                         区切りの線
 *   ![説明](https://…)          画像（その行だけ）
 *   [[ボタンの文字]](https://…) ボタン（その行だけ）
 *   空行で段落を分ける。段落の中の改行はそのまま改行
 * 行の中: **太字**、[文字](https://…) のリンク
 *
 * 差し込み（{{name}} など）は書き方を読んだ後に値を入れ、値はいつもエスケープする（お客様の名前に ** や [ ] があっても飾りにならない）。
 * リンクとボタンの先は https:// の URL（差し込みは入れない。お客様の値で飛び先が変わらないように）か、先まるごとの
 * URL の差し込み（{{product_url}}。入れた後も https:// でなければ文字だけにする）。画像は https:// だけ。
 * 特定電子メール法の表示と配信停止のリンクは、レイアウトの最後に手代が必ず付ける（本文からは消せない）。
 * 取引の知らせ（注文の受付・発送など、src/notices/）は宣伝ではないので配信停止のリンクを付けない（unsubscribeUrl なし）。
 *
 * かたまりの差し込み（{{order_details}} など、slots）は 1 行に単独で書く。HTML では手代が組んだ表、文字だけの版では文字の表になる。
 */

/** 1 通に入れられるリンク・ボタン・画像の数 */
export const MAX_LINKS = 100;

/** リンクの先に書ける差し込み（値が URL のもの） */
export const URL_PLACEHOLDERS = ["product_url", "order_url", "shop_url"] as const;

type Plain = { t: "text"; v: string } | { t: "link"; label: string; url: string };
/** 太字の中にはリンクを書ける（**[セールのページ](https://…)**）。太字の入れ子は無い */
type Inline = Plain | { t: "bold"; v: Plain[] };

export type Block =
  | { t: "h1" | "h2"; v: Inline[] }
  | { t: "p"; lines: Inline[][] }
  | { t: "ul"; items: Inline[][] }
  | { t: "hr" }
  | { t: "img"; alt: string; url: string }
  | { t: "button"; label: string; url: string }
  | { t: "slot"; name: string };

/** かたまりの差し込みの中身（手代が組んだもの。html はエスケープ済み） */
export type Slots = Record<string, { html: string; text: string }>;

/** 先の書き方: 空白の無い URL か、{{ 名前 }}（括弧の中の空白はあってもよい） */
/** URL の中の対になった括弧は URL の一部（https://ja.wikipedia.org/wiki/月_(曖昧さ回避) など） */
const URL_CHARS = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const TARGET = String.raw`\{\{\s*[a-z_]+\s*\}\}|${URL_CHARS}`;
const IMG_RE = new RegExp(String.raw`^!\[([^\]]*)\]\((${TARGET})\)$`);
const BUTTON_RE = new RegExp(String.raw`^\[\[([^\]]+)\]\]\((${TARGET})\)$`);

const isHttps = (v: string) => {
  if (v.length > 1000 || /[\s"'<>\\]/.test(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** 先まるごとが URL の差し込みなら、その名前 */
const urlPlaceholder = (v: string): string | null => {
  const m = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(v);
  return m && (URL_PLACEHOLDERS as readonly string[]).includes(m[1]!) ? m[1]! : null;
};

/** リンク・ボタンの先として書いてよいか（差し込みの無い https:// の URL か、先まるごとの URL の差し込みだけ） */
const linkTargetOk = (v: string) => (isHttps(v) && !v.includes("{{")) || urlPlaceholder(v) !== null;

const targetError = (what: string, v: string) =>
  v.includes("{{") && !urlPlaceholder(v)
    ? `${what}の URL の中には差し込みを書けません（お客様の値で飛び先が変わらないように。先まるごとの {{${URL_PLACEHOLDERS.join("}}・{{")}}} は使えます）: ${v.slice(0, 60)}`
    : `${what}は https:// の URL か {{${URL_PLACEHOLDERS.join("}}・{{")}}} にしてください: ${v.slice(0, 60)}`;

/** 先（{{ 名前 }} か URL）と閉じる ) を、その位置から読む */
const TARGET_AT = new RegExp(String.raw`(${TARGET})\)`, "y");

/**
 * 1 行の中のリンク（[文字](先)）を探す道具。どの位置から試しても、読む量が行の長さに比べて大きくならないようにする:
 * 次の ] の位置は前もって 1 回で求め、先の読み取りは ] ごとに 1 回だけ（同じ ] を使う [ がいくつあっても）
 */
function linkFinder(s: string): (i: number) => { label: string; url: string; end: number } | null {
  const nextClose = new Int32Array(s.length + 1).fill(-1);
  for (let k = s.length - 1; k >= 0; k--) nextClose[k] = s[k] === "]" ? k : nextClose[k + 1]!;
  const targets = new Map<number, { url: string; end: number } | null>();
  const targetAt = (k: number) => {
    if (!targets.has(k)) {
      TARGET_AT.lastIndex = k;
      const m = TARGET_AT.exec(s);
      targets.set(k, m ? { url: m[1]!, end: k + m[0].length } : null);
    }
    return targets.get(k)!;
  };
  return (i) => {
    if (s[i] !== "[") return null;
    const j = nextClose[i + 1] ?? -1;
    // 文字が空（[]）・閉じない・( が続かないものはリンクではない
    if (j <= i + 1 || s[j + 1] !== "(") return null;
    const t = targetAt(j + 2);
    return t ? { label: s.slice(i + 1, j), url: t.url, end: t.end } : null;
  };
}

/**
 * 行の中を読む（手書き。前は 1 つの正規表現で読んでいたが、閉じない太字の中にリンクを並べると試す数が指数的に増えた）。
 * 先頭から 1 文字ずつ進め、[ ではリンクを試し、** では閉じる ** を探す（太字の中のリンクは 1 つのかたまりとして飛ばす）。
 * 閉じない ** は文字のまま
 */
function parseInline(s: string, allowBold = true): Inline[] {
  const linkAt = linkFinder(s);
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const link = linkAt(i);
    if (link) {
      flush();
      out.push({ t: "link", label: link.label, url: link.url });
      i = link.end;
      continue;
    }
    if (allowBold && s.startsWith("**", i)) {
      let j = i + 2;
      let close = -1;
      while (j < s.length) {
        const inner = linkAt(j);
        if (inner) {
          j = inner.end;
          continue;
        }
        if (s.startsWith("**", j)) {
          close = j;
          break;
        }
        j++;
      }
      if (close > i + 2) {
        flush();
        out.push({ t: "bold", v: parseInline(s.slice(i + 2, close), false) as Plain[] });
        i = close + 2;
        continue;
      }
      // 閉じない **（か中身の無い ****）は文字のまま
      text += "**";
      i += 2;
      continue;
    }
    text += s[i];
    i++;
  }
  flush();
  return out;
}

/** 本文を読む。誤り（https でない先など）は画面に出す文 */
export function parseMailBody(src: string, slotNames: readonly string[] = []): { blocks: Block[]; errors: string[] } {
  const blocks: Block[] = [];
  const errors: string[] = [];
  let para: Inline[][] | null = null;
  let list: Inline[][] | null = null;
  const close = () => {
    if (para) blocks.push({ t: "p", lines: para });
    if (list) blocks.push({ t: "ul", items: list });
    para = null;
    list = null;
  };
  const checkInline = (xs: Inline[]) => {
    for (const x of xs.flatMap((y): Plain[] => (y.t === "bold" ? y.v : [y]))) if (x.t === "link" && !linkTargetOk(x.url)) errors.push(targetError("リンクの先", x.url));
    return xs;
  };
  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (t === "") {
      close();
      continue;
    }
    let m: RegExpExecArray | null;
    const slot = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(t);
    if (slot && slotNames.includes(slot[1]!)) {
      close();
      blocks.push({ t: "slot", name: slot[1]! });
      continue;
    }
    for (const n of slotNames) if (new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`).test(t)) errors.push(`{{${n}}} は 1 行に単独で書いてください`);
    const heading = /^(#{1,2})\s+/.exec(t);
    if (heading) {
      close();
      // 「##　小見出し」（全角の空白）も小見出し
      blocks.push({ t: heading[1]!.length === 2 ? "h2" : "h1", v: checkInline(parseInline(t.slice(heading[0].length))) });
    } else if (/^-{3,}$/.test(t)) {
      close();
      blocks.push({ t: "hr" });
    } else if ((m = IMG_RE.exec(t))) {
      close();
      if (m[2]!.includes("{{")) errors.push(`画像の URL の中には差し込みを書けません: ${m[2]!.slice(0, 60)}`);
      else if (!isHttps(m[2]!)) errors.push(`画像は https:// の URL にしてください: ${m[2]!.slice(0, 60)}`);
      blocks.push({ t: "img", alt: m[1]!, url: m[2]! });
    } else if ((m = BUTTON_RE.exec(t))) {
      close();
      if (!linkTargetOk(m[2]!)) errors.push(targetError("ボタンの先", m[2]!));
      blocks.push({ t: "button", label: m[1]!, url: m[2]! });
    } else if (/^(?:-\s+|・\s*)\S/.test(t)) {
      // 「- 項目」と「・項目」（中黒は後ろの空白が無くてもよい）
      if (para) close();
      (list ??= []).push(checkInline(parseInline(t.replace(/^(?:-\s+|・\s*)/, ""))));
    } else {
      if (list) close();
      (para ??= []).push(checkInline(parseInline(t)));
    }
  }
  close();
  // 1 通に入れられるリンク・ボタン・画像の数（多いと、送るたびに組み立てる時間が Workers の CPU の上限に近づくため）
  const inlineLinks = (xs: Inline[]) => xs.reduce((n, x) => n + (x.t === "link" ? 1 : x.t === "bold" ? x.v.filter((y) => y.t === "link").length : 0), 0);
  const links = blocks.reduce(
    (n, b) =>
      n +
      (b.t === "img" || b.t === "button"
        ? 1
        : b.t === "p"
          ? b.lines.reduce((m, l) => m + inlineLinks(l), 0)
          : b.t === "ul"
            ? b.items.reduce((m, l) => m + inlineLinks(l), 0)
            : b.t === "h1" || b.t === "h2"
              ? inlineLinks(b.v)
              : 0),
    0,
  );
  if (links > MAX_LINKS) errors.push(`リンク・ボタン・画像は 1 通に ${MAX_LINKS} 個までです（いま ${links} 個）`);
  return { blocks, errors };
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => (k in values ? values[k]! : all));

/** 先を差し込んで、https でなければ null（リンクにしない） */
const target = (url: string, values: Record<string, string>) => {
  // 差し込めるのは先まるごとの URL の差し込みだけ。書いた URL には値を入れない（お客様の値で飛び先が変わらないように）
  const name = urlPlaceholder(url);
  const v = name ? (values[name] ?? "") : url.includes("{{") ? "" : url;
  return isHttps(v) ? v : null;
};

export interface MailDesign {
  /** ボタン・見出しの線の色（#rrggbb） */
  accent: string;
  /** ロゴの画像（https://）。無ければショップの名前を文字で */
  logoUrl: string;
  shopName: string;
}

export interface MailFooter {
  lines: string[];
  /** 宣伝のメールだけ（取引の知らせには付けない） */
  unsubscribeUrl?: string;
}

export const DEFAULT_ACCENT = "#171717";
export const isColor = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

/** 相対輝度（WCAG） */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** 色の上に置く文字の色（白か黒の読みやすい方） */
function onColor(hex: string): string {
  const l = luminance(hex);
  // 黒と白のどちらが読みやすいかの境目（コントラスト比が等しくなる明るさ）は約 0.179
  return l > 0.179 ? "#111111" : "#ffffff";
}

const FONT = "-apple-system,BlinkMacSystemFont,'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif";

/** 白い地の上のリンクの色: 設定の色が白の上で読みにくい（コントラスト比 4.5 未満）なら、決まった濃い青 */
export const linkColor = (accent: string) => ((1.05) / (luminance(accent) + 0.05) >= 4.5 ? accent : "#1d4ed8");

function inlineHtml(xs: Inline[], values: Record<string, string>, accent: string): string {
  return xs
    .map((x): string => {
      if (x.t === "text") return escapeHtml(fill(x.v, values)).replace(/\n/g, "<br>");
      if (x.t === "bold") return `<strong>${inlineHtml(x.v, values, accent)}</strong>`;
      const href = target(x.url, values);
      const label = escapeHtml(fill(x.label, values));
      return href ? `<a href="${escapeHtml(href)}" style="color:${linkColor(accent)};text-decoration:underline">${label}</a>` : label;
    })
    .join("");
}

function inlineText(xs: Inline[], values: Record<string, string>): string {
  return xs
    .map((x): string => {
      if (x.t === "text") return fill(x.v, values);
      if (x.t === "bold") return inlineText(x.v, values);
      const href = target(x.url, values);
      const label = fill(x.label, values);
      return href && href !== label ? `${label}（${href}）` : label;
    })
    .join("");
}

/** 本文の HTML（レイアウトの中身だけ） */
export function bodyHtml(blocks: Block[], values: Record<string, string>, accent: string, slots: Slots = {}): string {
  const P = `margin:0 0 16px;font-size:15px;line-height:1.8;color:#222222`;
  return blocks
    .map((b) => {
      switch (b.t) {
        case "h1":
          return `<h1 style="margin:8px 0 16px;font-size:22px;line-height:1.4;color:#111111">${inlineHtml(b.v, values, accent)}</h1>`;
        case "h2":
          return `<h2 style="margin:24px 0 12px;padding-left:10px;border-left:4px solid ${accent};font-size:17px;line-height:1.5;color:#111111">${inlineHtml(b.v, values, accent)}</h2>`;
        case "p":
          return `<p style="${P}">${b.lines.map((l) => inlineHtml(l, values, accent)).join("<br>")}</p>`;
        case "ul":
          return `<ul style="margin:0 0 16px;padding-left:1.4em;font-size:15px;line-height:1.8;color:#222222">${b.items.map((i) => `<li>${inlineHtml(i, values, accent)}</li>`).join("")}</ul>`;
        case "hr":
          return `<hr style="border:0;border-top:1px solid #e5e5e5;margin:24px 0">`;
        case "img":
          return isHttps(b.url)
            ? `<p style="margin:0 0 16px"><img src="${escapeHtml(b.url)}" alt="${escapeHtml(fill(b.alt, values))}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0"></p>`
            : "";
        case "button": {
          const href = target(b.url, values);
          const label = escapeHtml(fill(b.label, values));
          if (!href) return `<p style="${P}">${label}</p>`;
          return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 24px"><tr><td align="center" bgcolor="${accent}" style="border-radius:6px;background:${accent};padding:12px 28px"><a href="${escapeHtml(href)}" style="display:inline-block;font-size:15px;font-weight:bold;color:${onColor(accent)};text-decoration:none">${label}</a></td></tr></table>`;
        }
        case "slot":
          return slots[b.name]?.html ?? "";
      }
    })
    .join("\n");
}

/** 文字だけの版 */
export function bodyText(blocks: Block[], values: Record<string, string>, slots: Slots = {}): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "h1":
        out.push(`■ ${inlineText(b.v, values)}`);
        break;
      case "h2":
        out.push(`◆ ${inlineText(b.v, values)}`);
        break;
      case "p":
        out.push(b.lines.map((l) => inlineText(l, values)).join("\n"));
        break;
      case "ul":
        out.push(b.items.map((i) => `・${inlineText(i, values)}`).join("\n"));
        break;
      case "hr":
        out.push("――――――――――");
        break;
      case "img":
        if (b.alt) out.push(`（画像: ${fill(b.alt, values)}）`);
        break;
      case "button": {
        const href = target(b.url, values);
        out.push(href ? `▶ ${fill(b.label, values)}\n${href}` : fill(b.label, values));
        break;
      }
      case "slot":
        if (slots[b.name]?.text) out.push(slots[b.name]!.text);
        break;
    }
  }
  return out.join("\n\n");
}

/** 決まったレイアウトに流し込んだ HTML の文書（幅 600px・表組み・インラインの style） */
export function layoutHtml(opts: { subject: string; body: string; design: MailDesign; footer: MailFooter }): string {
  const d = opts.design;
  const accent = isColor(d.accent) ? d.accent : DEFAULT_ACCENT;
  const head = isHttps(d.logoUrl)
    ? `<img src="${escapeHtml(d.logoUrl)}" alt="${escapeHtml(d.shopName)}" height="40" style="display:block;height:40px;width:auto;max-width:240px;border:0">`
    : `<span style="font-size:18px;font-weight:bold;color:#111111">${escapeHtml(d.shopName)}</span>`;
  const foot = opts.footer.lines.map((l) => escapeHtml(l)).join("<br>");
  const unsub = opts.footer.unsubscribeUrl ? `<br>\n<a href="${escapeHtml(opts.footer.unsubscribeUrl)}" style="color:#71717a;text-decoration:underline">このお知らせの配信を止める</a>` : "";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(opts.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;border-top:4px solid ${accent}">
<tr><td style="padding:24px 32px 8px">${head}</td></tr>
<tr><td style="padding:16px 32px 8px;font-family:${FONT}">
${opts.body}
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="padding:16px 32px;font-size:12px;line-height:1.7;color:#71717a;font-family:${FONT}">
${foot}${unsub}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** 文字だけの版の最後に付ける表示 */
export const footerText = (f: MailFooter) =>
  f.lines.length === 0 && !f.unsubscribeUrl ? "" : ["", "――――――――――", ...f.lines, ...(f.unsubscribeUrl ? [`このお知らせの配信を止める: ${f.unsubscribeUrl}`] : [])].join("\n");

/** 本文の書き方 → HTML の文書と文字だけの版 */
export function composeHtmlMail(opts: { subject: string; source: string; values: Record<string, string>; design: MailDesign; footer: MailFooter; slots?: Slots }): { html: string; text: string } {
  const slots = opts.slots ?? {};
  const { blocks } = parseMailBody(opts.source, Object.keys(slots));
  const accent = isColor(opts.design.accent) ? opts.design.accent : DEFAULT_ACCENT;
  return {
    html: layoutHtml({ subject: opts.subject, body: bodyHtml(blocks, opts.values, accent, slots), design: opts.design, footer: opts.footer }),
    text: `${bodyText(blocks, opts.values, slots)}\n${footerText(opts.footer)}\n`,
  };
}
