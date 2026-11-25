/**
 * Cloudflare Workers の入口。本体（src/app.tsx・src/jobs.ts）はランタイムに依存しない。
 */
import { createApp, notConfigured } from "./app";
import { d1Sql } from "./adapters/workers/d1";
import { readConfig, type Deps } from "./deps";
import { runScheduled } from "./jobs";
import { workersSockets } from "./adapters/workers/socket";

export interface WorkerEnv {
  DB: D1Database;
  BANTO_URL?: string;
  TEDAI_SECRET?: string;
  MAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_TLS?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SLACK_WEBHOOK_URL?: string;
}

const app = createApp();

function deps(env: WorkerEnv): Deps | { missing: string[] } {
  const cfg = readConfig(env as unknown as Record<string, unknown>);
  if (!cfg.ok) return { missing: cfg.missing };
  // fetch はそのまま渡す（別のオブジェクトのメソッドとして呼ぶと Illegal invocation になる）
  const f: typeof fetch = (input, init) => fetch(input, init);
  return { db: d1Sql(env.DB), fetch: f, now: () => Math.floor(Date.now() / 1000), config: cfg.config, sockets: workersSockets };
}

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const d = deps(env);
    if ("missing" in d) return notConfigured(req, d.missing);
    return app.fetch(req, d, ctx);
  },
  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = deps(env);
    if ("missing" in d) {
      console.error("not configured", d.missing.join(","));
      return;
    }
    ctx.waitUntil(runScheduled(d));
  },
} satisfies ExportedHandler<WorkerEnv>;
