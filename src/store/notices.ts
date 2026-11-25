/** 取引の知らせの文面と、送る列（src/notices/） */
import { DEFAULT_HTML, defaultTemplate, isNoticeKind, NOTICE_KINDS, type NoticeKind, type NoticeTemplate } from "../notices/kinds";
import type { SqlDb } from "./sql";

interface TemplateRow {
  kind: string;
  enabled: number;
  format: string;
  subject: string;
  body: string;
}

const fromRow = (r: TemplateRow & { kind: NoticeKind }): NoticeTemplate => ({ kind: r.kind, enabled: r.enabled === 1, format: r.format === "html" ? "html" : "text", subject: r.subject, body: r.body });

/** 種類ごとの文面（保存していない種類は既定の文面・送らない） */
export async function listTemplates(db: SqlDb, shopId: string): Promise<NoticeTemplate[]> {
  const rows = await db.all<TemplateRow>(`SELECT kind, enabled, format, subject, body FROM notice_templates WHERE shop_id = ?`, [shopId]);
  return NOTICE_KINDS.map(({ kind }) => {
    const r = rows.find((x) => x.kind === kind);
    return r ? fromRow({ ...r, kind }) : defaultTemplate(kind);
  });
}

export async function getTemplate(db: SqlDb, shopId: string, kind: NoticeKind): Promise<NoticeTemplate> {
  const r = await db.first<TemplateRow>(`SELECT kind, enabled, format, subject, body FROM notice_templates WHERE shop_id = ? AND kind = ?`, [shopId, kind]);
  return r ? fromRow({ ...r, kind }) : defaultTemplate(kind);
}

export async function saveTemplate(db: SqlDb, shopId: string, t: NoticeTemplate, now: number): Promise<void> {
  await db.run(
    `INSERT INTO notice_templates (shop_id, kind, enabled, format, subject, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_id, kind) DO UPDATE SET enabled = excluded.enabled, format = excluded.format, subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`,
    [shopId, t.kind, t.enabled ? 1 : 0, t.format, t.subject, t.body, now],
  );
}

/** 「送る」にしている種類（出来事を受け取るたびに読むので、列だけ） */
export async function enabledKinds(db: SqlDb, shopId: string): Promise<NoticeKind[]> {
  const rows = await db.all<{ kind: string }>(`SELECT kind FROM notice_templates WHERE shop_id = ? AND enabled = 1`, [shopId]);
  return rows.map((r) => r.kind).filter(isNoticeKind);
}

/** 既定の文面（形ごと） */
export const defaultBody = (kind: NoticeKind, format: "text" | "html") => (format === "html" ? DEFAULT_HTML[kind] : defaultTemplate(kind).body);

/** 送る列に積む。同じ注文 × 種類は 1 回だけ（Banto の再送・同じ出来事が 2 度来ても）。積んだら true */
export async function enqueueNotice(db: SqlDb, shopId: string, orderId: string, kind: NoticeKind, now: number): Promise<boolean> {
  const r = await db.run(`INSERT OR IGNORE INTO notice_sends (shop_id, order_id, kind, status, due_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`, [
    shopId,
    orderId,
    kind,
    now,
    now,
    now,
  ]);
  return r.changes > 0;
}

export interface NoticeSendRow {
  shop_id: string;
  order_id: string;
  kind: NoticeKind;
  status: "pending" | "done" | "skipped" | "failed";
  result: string | null;
  attempts: number;
  due_at: number;
  last_error: string | null;
  order_number: number | null;
  /** SMTP で送り始めた時刻（送っている途中の印。終えたら消す） */
  sending_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function dueNotices(db: SqlDb, now: number, max: number, shopId?: string): Promise<NoticeSendRow[]> {
  return shopId
    ? db.all<NoticeSendRow>(`SELECT * FROM notice_sends WHERE status = 'pending' AND due_at <= ? AND shop_id = ? ORDER BY due_at LIMIT ?`, [now, shopId, max])
    : db.all<NoticeSendRow>(`SELECT * FROM notice_sends WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?`, [now, max]);
}

export async function finishNotice(db: SqlDb, row: Pick<NoticeSendRow, "shop_id" | "order_id" | "kind">, patch: { status: NoticeSendRow["status"]; result?: string | null; attempts?: number; due_at?: number; last_error?: string | null; order_number?: number | null }, now: number): Promise<void> {
  await db.run(
    `UPDATE notice_sends SET status = ?, result = COALESCE(?, result), attempts = COALESCE(?, attempts), due_at = COALESCE(?, due_at), last_error = ?, order_number = COALESCE(?, order_number), sending_at = NULL, updated_at = ?
     WHERE shop_id = ? AND order_id = ? AND kind = ?`,
    [patch.status, patch.result ?? null, patch.attempts ?? null, patch.due_at ?? null, patch.last_error ?? null, patch.order_number ?? null, now, row.shop_id, row.order_id, row.kind],
  );
}

export async function recentNotices(db: SqlDb, shopId: string, limit = 50, status?: string): Promise<NoticeSendRow[]> {
  return status
    ? db.all<NoticeSendRow>(`SELECT * FROM notice_sends WHERE shop_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`, [shopId, status, limit])
    : db.all<NoticeSendRow>(`SELECT * FROM notice_sends WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?`, [shopId, limit]);
}

/** 失敗した行をもう一度送る列に戻す */
export async function retryNotice(db: SqlDb, shopId: string, orderId: string, kind: NoticeKind, now: number): Promise<boolean> {
  return (await db.run(`UPDATE notice_sends SET status = 'pending', attempts = 0, due_at = ?, last_error = NULL, updated_at = ? WHERE shop_id = ? AND order_id = ? AND kind = ? AND status = 'failed'`, [now, now, shopId, orderId, kind])).changes > 0;
}

/** 送り直せる失敗の古さ（これより前の注文の知らせを、いまさら送らない） */
export const RETRY_FAILED_WITHIN_SECONDS = 7 * 86400;

export async function countFailed(db: SqlDb, shopId: string, now: number): Promise<number> {
  return (
    (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM notice_sends WHERE shop_id = ? AND status = 'failed' AND created_at >= ? AND COALESCE(last_error, '') <> 'interrupted'`, [shopId, now - RETRY_FAILED_WITHIN_SECONDS]))?.n ?? 0
  );
}

/** 失敗した知らせ（7 日以内に受け取ったもの）をまとめて送る列に戻す。戻した数を返す */
export async function retryFailedNotices(db: SqlDb, shopId: string, now: number): Promise<number> {
  return (
    // 途中で切れた行（interrupted）は送れていたかもしれないので、まとめては送り直さない（1 件ずつ確かめて送り直す）
    await db.run(`UPDATE notice_sends SET status = 'pending', attempts = 0, due_at = ?, last_error = NULL, updated_at = ? WHERE shop_id = ? AND status = 'failed' AND created_at >= ? AND COALESCE(last_error, '') <> 'interrupted'`, [
      now,
      now,
      shopId,
      now - RETRY_FAILED_WITHIN_SECONDS,
    ])
  ).changes;
}

/** 記録は 90 日で消す（注文 ID と時刻だけだが、増え続けないように） */
export async function pruneNotices(db: SqlDb, now: number, keepSeconds = 90 * 86400): Promise<number> {
  return (await db.run(`DELETE FROM notice_sends WHERE status <> 'pending' AND updated_at < ?`, [now - keepSeconds])).changes;
}
