/**
 * 手代の本体が外に頼るもの。ランタイム（Workers / Node）の入口が組み立てて渡す。
 * Cloudflare の型はここに持ち込まない（src/index.ts と src/adapters/workers/ だけ）。
 */
import type { SqlDb } from "./store/sql";
import type { SocketAdapter } from "./mail/socket";
import { readMailConfig, type MailConfig } from "./mail/transport";
import { parsePlan } from "./budget";

export interface Deps {
  db: SqlDb;
  /** 外への fetch。Workers の fetch は `deps.fetch(...)` の形で呼ぶと Illegal invocation になるので、呼ぶ側は必ず `const f = deps.fetch; f(...)` か入口で bind したものを渡す */
  fetch: typeof fetch;
  /** UNIX 秒（テストで固定する） */
  now: () => number;
  config: Config;
  /** SMTP で送るときだけ（Workers は cloudflare:sockets） */
  sockets?: SocketAdapter;
}

export interface Config {
  /** つなぐ Banto の origin（例 https://shop.example.com）。末尾の / なし */
  bantoOrigin: string;
  /** 手代の秘密（32 文字以上） */
  secret: string;
  /** 案内メールの送り手（無ければメールのアクションを使わせない） */
  mail: MailConfig | null;
  /** 送り手の変数の足りない・形の違う名前 */
  mailProblems: string[];
  /** 運営者への知らせの Slack（Incoming Webhook の URL）。無ければ Slack のアクションを使わせない */
  slackWebhookUrl: string | null;
  /** Cloudflare Workers のプラン（Cron 1 回で使ってよい D1・fetch の数を決める。src/budget.ts）。変数 WORKERS_PLAN、既定 free */
  workersPlan?: "free" | "paid";
}

export const VERSION = "0.4.0";

export type ConfigResult = { ok: true; config: Config } | { ok: false; missing: string[] };

/** 変数を読み、足りないもの・形の違うものの名前を返す */
export function readConfig(env: Record<string, unknown>): ConfigResult {
  const missing: string[] = [];
  const rawUrl = typeof env["BANTO_URL"] === "string" ? env["BANTO_URL"].trim() : "";
  let bantoOrigin = "";
  try {
    const u = new URL(rawUrl);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) bantoOrigin = u.origin;
  } catch {
    bantoOrigin = "";
  }
  if (!bantoOrigin) missing.push("BANTO_URL");
  const secret = typeof env["TEDAI_SECRET"] === "string" ? env["TEDAI_SECRET"] : "";
  if (secret.length < 32) missing.push("TEDAI_SECRET");
  const mail = readMailConfig(env);
  const slack = typeof env["SLACK_WEBHOOK_URL"] === "string" && /^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_-]{10,300}$/.test(env["SLACK_WEBHOOK_URL"].trim()) ? env["SLACK_WEBHOOK_URL"].trim() : null;
  return missing.length > 0
    ? { ok: false, missing }
    : { ok: true, config: { bantoOrigin, secret, mail: mail.config, mailProblems: mail.problems, slackWebhookUrl: slack, workersPlan: parsePlan(env["WORKERS_PLAN"]) } };
}
