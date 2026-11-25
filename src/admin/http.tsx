/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSX } from "hono/jsx/jsx-runtime";
import type { Deps } from "../deps";
import { Message } from "./views";

export type Env = { Bindings: Deps };
export type C = Context<Env>;

/** メールの見本（sandbox の srcdoc）を載せる画面の印。共通のヘッダ（app.tsx）が読んで外し、その画面だけ img-src に https: を足す */
export const MAIL_PREVIEW_HEADER = "X-Tedai-Mail-Preview";

/** 画面を返す（標準モードで描かせるため doctype を付ける）。mailPreview: メールの見本を載せる画面 */
export function page(c: C, el: JSX.Element, status: ContentfulStatusCode = 200, opts: { mailPreview?: boolean } = {}) {
  if (opts.mailPreview) c.header(MAIL_PREVIEW_HEADER, "1");
  return c.html("<!doctype html>" + String(el), status);
}

export function expired(c: C) {
  return page(
    c,
    <Message title="開き直してください" tone="bad">
      <p>画面の期限（60 分）が切れたか、Banto の管理画面を通らずに開いています。手代の画面は、Banto の管理画面 → 連携 → 手代 から開きます。</p>
      <p>
        <a class="btn secondary" href={`${c.env.config.bantoOrigin}/admin`} target="_top">
          Banto の管理画面へ
        </a>
      </p>
    </Message>,
    401,
  );
}
