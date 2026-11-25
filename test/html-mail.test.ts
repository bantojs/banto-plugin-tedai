import { describe, expect, it } from "vitest";
import { composeHtmlMail, linkColor, parseMailBody } from "../src/mail/html";
import { buildMimeMessage } from "../src/mail/message";
import { parseActionsForm } from "../src/rules/actions";
import { EMPTY_SETTINGS, parseSettingsForm } from "../src/store/settings";

const design = { accent: "#c2410c", logoUrl: "", shopName: "テストの店" };
const footer = { lines: ["送信者: 株式会社テスト", "住所: 東京都", "お問い合わせ: info@shop.example"], unsubscribeUrl: "https://tedai.example/u/tok" };
const SRC = `# {{name}} さんへ
いつもありがとうございます。
**{{shop}}** からのお知らせです。

- 1 つめ
- [2 つめ](https://shop.example/a)
---
![新作](https://shop.example/img.jpg)
[[商品を見る]]({{product_url}})`;

describe("飾りのあるメール", () => {
  it("決まった書き方を読み、https でない先を断る", () => {
    const { blocks, errors } = parseMailBody(SRC);
    expect(errors).toEqual([]);
    expect(blocks.map((b) => b.t)).toEqual(["h1", "p", "ul", "hr", "img", "button"]);
    expect(parseMailBody("[x](http://a.example)\n![y](javascript:alert(1))\n[[z]](mailto:a@b)").errors).toHaveLength(3);
  });

  it("差し込みの値はエスケープし、飾りにならない", () => {
    const values = { name: '<script>alert(1)</script>**太**[x](https://evil.example)', shop: "A&B", product_url: "https://shop.example/products/p" };
    const { html, text } = composeHtmlMail({ subject: "件名", source: SRC, values, design, footer });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain("<strong>A&amp;B</strong>");
    expect(html).toContain('href="https://shop.example/products/p"');
    expect(html).toContain('src="https://shop.example/img.jpg"');
    expect(html).toContain("background:#c2410c");
    // 特定電子メール法の表示と配信停止は必ず付く
    expect(html).toContain("株式会社テスト");
    expect(html).toContain('href="https://tedai.example/u/tok"');
    expect(text).toContain("・2 つめ（https://shop.example/a）");
    expect(text).toContain("▶ 商品を見る\nhttps://shop.example/products/p");
    expect(text).toContain("このお知らせの配信を止める: https://tedai.example/u/tok");
  });

  it("差し込んだ先が https でなければ、リンクにしない", () => {
    const { html } = composeHtmlMail({ subject: "s", source: "[[見る]]({{product_url}})", values: { product_url: "" }, design, footer });
    expect(html).toContain("見る");
    expect(html).not.toMatch(/<a href="[^"]*"[^>]*>見る/);
  });

  it("HTML があれば multipart/alternative にする", () => {
    const msg = buildMimeMessage({ from: "店 <news@shop.example>", to: "a@example.com", subject: "s", text: "文字", html: "<p>飾り</p>" });
    const m = /boundary="([^"]+)"/.exec(msg.data);
    expect(m).not.toBeNull();
    const parts = msg.data.split(`--${m![1]}`);
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(parts[2]).toContain("Content-Type: text/html; charset=UTF-8");
    expect(parts[3]).toBe("--\r\n");
    expect(Buffer.from(parts[2]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toBe("<p>飾り</p>");
    expect(buildMimeMessage({ from: "a@b.example", to: "c@d.example", subject: "s", text: "t" }).data).toContain("\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
  });

  it("ルールの保存で、飾りありの本文の誤りを出す", () => {
    const ctx = { mailTransport: true, mailSettings: true, operatorEmail: true, slack: true };
    const base = { message_on: "1", channel: "email", email_subject: "件名", email_format: "html" };
    expect(parseActionsForm({ ...base, email_body: "[x](http://a.example)" }, ctx).errors.join()).toContain("https://");
    const ok = parseActionsForm({ ...base, email_body: "# やあ" }, ctx);
    expect(ok.errors).toEqual([]);
    expect(ok.actions.message?.email_format).toBe("html");
    // 文字だけなら書き方は読まない
    expect(parseActionsForm({ ...base, email_format: "text", email_body: "[x](http://a.example)" }, ctx).errors).toEqual([]);
  });

  it("設定の色とロゴを確かめる", () => {
    expect(parseSettingsForm({ mail_accent: "#C2410C", mail_logo_url: "https://shop.example/logo.png" }).settings).toMatchObject({ mail_accent: "#c2410c", mail_logo_url: "https://shop.example/logo.png" });
    expect(parseSettingsForm({ mail_accent: "red" }).errors.join()).toContain("#rrggbb");
    expect(parseSettingsForm({ mail_logo_url: "http://shop.example/logo.png" }).errors.join()).toContain("ロゴ");
    expect(parseSettingsForm({}).settings.mail_accent).toBe(EMPTY_SETTINGS.mail_accent);
  });

  it("書いた URL の中には差し込みを入れない（お客様の値で飛び先が変わらない）", () => {
    for (const src of ["[x](https://shop.example{{name}})", "[[x]](https://shop.example/?q={{name}})", "[x](https://{{name}}.shop.example/)"]) {
      expect(parseMailBody(src).errors.join()).toContain("差し込みを書けません");
    }
    // 保存を通らない形でも、描くときに値を入れない（先は文字だけになる）
    const { html } = composeHtmlMail({ subject: "s", source: "[x](https://shop.example{{name}})", values: { name: "@evil.example" }, design, footer });
    expect(html).not.toContain("evil.example");
    expect(html).not.toMatch(/<a href="https:\/\/shop\.example/);
    // 先まるごとの差し込みは使える（括弧の中の空白もよい）
    expect(parseMailBody("[[見る]]({{ product_url }})").errors).toEqual([]);
    const ok = composeHtmlMail({ subject: "s", source: "[[見る]]({{ product_url }})", values: { product_url: "https://shop.example/p" }, design, footer });
    expect(ok.html).toContain('href="https://shop.example/p"');
  });

  it("全角の空白の小見出し、空白の無い中黒の箇条書きも読む", () => {
    expect(parseMailBody("##　小見出し").blocks[0]).toMatchObject({ t: "h2" });
    expect(parseMailBody("#　見出し").blocks[0]).toMatchObject({ t: "h1" });
    expect(parseMailBody("・りんご\n・みかん").blocks).toEqual([{ t: "ul", items: [[{ t: "text", v: "りんご" }], [{ t: "text", v: "みかん" }]] }]);
    expect(parseMailBody("-1 度").blocks[0]).toMatchObject({ t: "p" });
  });

  it("ボタンの余白は表の枠に付ける（Outlook でも崩れない）", () => {
    const { html } = composeHtmlMail({ subject: "s", source: "[[見る]](https://shop.example)", values: {}, design, footer });
    expect(html).toMatch(/<td align="center" bgcolor="#c2410c" style="[^"]*padding:12px 28px/);
  });

  it("色の欄は切り詰めずに確かめる", () => {
    expect(parseSettingsForm({ mail_accent: "#c2410cff" }).errors.join()).toContain("#rrggbb");
  });

  it("太字の中のリンクも読み、先を確かめる", () => {
    const { html, text } = composeHtmlMail({ subject: "s", source: "**[セールのページ](https://shop.example/sale)** をどうぞ", values: {}, design, footer });
    expect(html).toContain('<strong><a href="https://shop.example/sale"');
    expect(html).toContain("セールのページ</a></strong>");
    expect(text).toContain("セールのページ（https://shop.example/sale） をどうぞ");
    expect(parseMailBody("**[x](http://a.example)**").errors.join()).toContain("https://");
    expect(parseMailBody("**[x](https://a.example/{{name}})**").errors.join()).toContain("差し込みを書けません");
  });

  it("URL の中の対になった括弧は URL の一部", () => {
    const url = "https://ja.wikipedia.org/wiki/月_(曖昧さ回避)";
    const { html } = composeHtmlMail({ subject: "s", source: `[月](${url})\n\n![図](https://shop.example/a(1).png)\n\n[[見る]](${url})`, values: {}, design, footer });
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain("</a>)");
    expect(html).toContain('src="https://shop.example/a(1).png"');
    expect(parseMailBody(`[月](${url})`).errors).toEqual([]);
  });

  it("画像の URL の中の差し込みは保存のときに断る", () => {
    expect(parseMailBody("![x](https://shop.example/{{name}}.png)").errors.join()).toContain("差し込みを書けません");
  });

  it("太字の中のリンクの URL に ** があっても崩れない", () => {
    const { html } = composeHtmlMail({ subject: "s", source: "**[a](https://x.example/**)** です", values: {}, design, footer });
    expect(html).toContain('<strong><a href="https://x.example/**"');
    expect(html).toContain("</a></strong> です");
  });

  it("ボタンの文字は読みやすい方の色、リンクは白の上で読める色", () => {
    const btn = (accent: string) => /color:(#[0-9a-f]{6});text-decoration:none/.exec(composeHtmlMail({ subject: "s", source: "[[見る]](https://shop.example)", values: {}, design: { ...design, accent }, footer }).html)![1];
    expect(btn("#06b6d4")).toBe("#111111");
    expect(btn("#f97316")).toBe("#111111");
    expect(btn("#1e3a8a")).toBe("#ffffff");
    expect(linkColor("#facc15")).toBe("#1d4ed8");
    expect(linkColor("#1e3a8a")).toBe("#1e3a8a");
  });

  it("どんな本文でも読むのに時間がかからない（閉じない太字・閉じない括弧を並べても）", () => {
    const inputs = [
      "**" + "[a](b)".repeat(800) + "x",
      "**" + "[a](https://x.example)".repeat(200),
      "[".repeat(5000),
      "[a](".repeat(1200),
      "**".repeat(2500),
      ("**[a](https://x.example/**)" + "x").repeat(150),
      "**" + "[".repeat(4998),
      "[".repeat(2500) + "a](" + "x".repeat(2400),
      "**" + "[a](".repeat(1249),
    ];
    for (const src of inputs) {
      const t = Date.now();
      parseMailBody(src);
      // 手元で数ミリ秒（前の作りでは数秒〜数十秒）。CI の揺れを見込んで、長さに比べて大きく伸びていないことだけを縛る
      expect(Date.now() - t, src.slice(0, 20)).toBeLessThan(50);
    }
  });

  it("リンク・ボタン・画像は 1 通に 100 個まで", () => {
    expect(parseMailBody("[a](https://x.example) ".repeat(100)).errors).toEqual([]);
    expect(parseMailBody("[a](https://x.example) ".repeat(101)).errors.join()).toContain("100 個まで");
  });

  it("閉じない ** と中身の無い **** は文字のまま", () => {
    for (const src of ["2**3 は 8", "****"]) {
      const { text, html } = composeHtmlMail({ subject: "s", source: src, values: {}, design, footer });
      expect(text).toContain(src);
      expect(html).not.toContain("<strong>");
    }
  });
});
