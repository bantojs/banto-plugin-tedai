/**
 * 受け取った出来事の処理。署名と配信 ID の冪等は受け口（app.tsx）で済ませてから呼ぶ。
 * 失敗したら投げる → 受け口が 500 を返し、Banto が 2・4・8・16 分後に送り直す。
 * Banto は 10 秒で待つのをやめるので、ここでは Banto の API を呼ばない（明細の会員 ID・商品 ID は hooks に載っている）。
 */
import type { Deps } from "./deps";
import type { Connection } from "./store/connections";
import { onOrderPaid } from "./rules/trigger";
import { favoriteRules, onInventoryLow, onProductUpdated } from "./rules/favorites";
import { onCheckoutAbandoned } from "./rules/abandoned";
import { addFavorite, removeFavorite } from "./store/favorites";
import { cancelOrder, forgetCustomer, HOOK_TRIGGERED, parseOrder, recordOrder } from "./store/purchases";
import { kindOf, noticeGroup, type NoticeKind } from "./notices/kinds";
import { enabledKinds, enqueueNotice, finishNotice } from "./store/notices";

/**
 * いま処理する出来事。これ以外（banto.ping・後の版で使う product.updated / inventory.low）は 200 を返すだけで、
 * 配信 ID も D1 に書かない（商品を保存するたびに届くので、書き込みの行数を使わない）
 */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set(["order.paid", "order.cancelled", "customer.deleted", "favorite.added", "favorite.removed"]);

/** 処理するか（product.updated・inventory.low は、お気に入りのルールが動いているショップだけ。ほかは配信 ID も書かない） */
export async function isHandled(deps: Deps, shopId: string, event: string): Promise<boolean> {
  if (HANDLED_EVENTS.has(event)) return true;
  // カゴ落ちはルールが無くても受け取った時刻だけ覚える（届いているかを画面に出す）。数は少ない
  if (event === "checkout.abandoned") return true;
  // order.created・order.shipped は取引の知らせ（src/notices/）だけが使う。送る種類が無ければ配信 ID も書かない
  if (event === "order.created") return (await enabledKinds(deps.db, shopId)).includes("received");
  if (event === "order.shipped") return (await enabledKinds(deps.db, shopId)).includes("shipped");
  // お店で試着の出来事も、試着の知らせを送るときだけ
  if (event === "tryon.requested" || event === "tryon.updated") return (await enabledKinds(deps.db, shopId)).some((k) => noticeGroup(k) === "tryon");
  // お支払いのお願いも、送るときだけ
  if (event === "checkout.payment_pending") return (await enabledKinds(deps.db, shopId)).includes("payment_reminder");
  if (event === "product.updated") return (await favoriteRules(deps.db, shopId, ["favorite_restock", "favorite_price_drop"])).length > 0;
  if (event === "inventory.low") return (await favoriteRules(deps.db, shopId, ["favorite_low_stock"])).length > 0;
  return false;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const id = (v: unknown): string | null => (typeof v === "string" && ID_RE.test(v) ? v : null);

export interface Envelope {
  id: string;
  event: string;
  created_at: string;
  shop_id: string;
  attempt: number;
  data: Record<string, unknown>;
}

const isoSeconds = (s: unknown, fallback: number): number => {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : fallback;
};

/** 注文の出来事なら、送ると決めている取引の知らせを列に積む（送るのは受け取りの応答の後と Cron。src/notices/send.ts） */
export async function enqueueNoticeFor(deps: Deps, shopId: string, envelope: Envelope): Promise<boolean> {
  const kind = kindOf(envelope.event, envelope.data);
  if (!kind) return false;
  // お客様が「お知らせを LINE だけで受け取る」を選び、Banto がそれを効かせた知らせ（Banto 0176、hooks の notice_line_only）。
  // お客様には Banto が LINE で送るので、手代はメールを送らない（記録には「LINE だけ」で残す）
  const lineOnly = envelope.data["notice_line_only"] === true;
  if (noticeGroup(kind) === "tryon") {
    // お店で試着: 申し込みの ID と受付番号（送る直前に番号で読む）。延長は延長のたびに 1 通（回数ごとに別の行）
    const requestId = id(envelope.data["request_id"]);
    const number = envelope.data["number"];
    if (!requestId || typeof number !== "number" || !Number.isInteger(number) || number <= 0) return false;
    const count = envelope.data["extend_count"];
    const key = kind === "tryon_extended" ? `${requestId}-e${typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 1}` : requestId;
    if (!(await enabledKinds(deps.db, shopId)).includes(kind)) return false;
    return lineOnly ? recordLineOnly(deps, shopId, key, kind, number) : enqueueNotice(deps.db, shopId, key, kind, deps.now(), number);
  }
  if (noticeGroup(kind) === "payment") {
    // お支払いのお願い: 予約の ID（送る直前に 0182 の口で読む）。予約ごとに 1 回
    const reservationId = id(envelope.data["reservation_id"]);
    if (!reservationId) return false;
    if (!(await enabledKinds(deps.db, shopId)).includes(kind)) return false;
    return lineOnly ? recordLineOnly(deps, shopId, reservationId, kind, null) : enqueueNotice(deps.db, shopId, reservationId, kind, deps.now());
  }
  const orderId = id(envelope.data["order_id"]);
  if (!orderId) return false;
  if (!(await enabledKinds(deps.db, shopId)).includes(kind)) return false;
  const number = typeof envelope.data["number"] === "number" && Number.isInteger(envelope.data["number"]) ? (envelope.data["number"] as number) : null;
  return lineOnly ? recordLineOnly(deps, shopId, orderId, kind, number) : enqueueNotice(deps.db, shopId, orderId, kind, deps.now());
}

/** 「LINE だけ」の知らせは送らずに、送らなかった記録だけ残す（送った記録の画面で分かるように） */
async function recordLineOnly(deps: Deps, shopId: string, key: string, kind: NoticeKind, number: number | null): Promise<boolean> {
  const now = deps.now();
  if (!(await enqueueNotice(deps.db, shopId, key, kind, now, number))) return false;
  await finishNotice(deps.db, { shop_id: shopId, order_id: key, kind }, { status: "skipped", result: "line_only", last_error: null }, now);
  return false;
}

export async function handleEvent(deps: Deps, connection: Connection, envelope: Envelope): Promise<void> {
  const shopId = connection.shop_id;
  const d = envelope.data;
  // 取引の知らせはゲストの注文にも送るので、会員の注文を数える処理より先に
  await enqueueNoticeFor(deps, shopId, envelope);
  switch (envelope.event) {
    case "order.paid": {
      if (typeof d["customer_id"] !== "string") return; // ゲストの注文は数えない
      const o = parseOrder(d, { orderedAt: isoSeconds(envelope.created_at, deps.now()), cancelled: false, bantoUpdatedAt: null });
      if (!o) {
        console.error("order.paid: unreadable payload");
        return;
      }
      await recordOrder(deps.db, shopId, o);
      // 明細がそろっていれば、ここでルールを確かめ、当たりと同じ取引で「確かめた」印を残す（取りこぼしの読み直しで当て直さない。
      // 印だけが先に残って確かめずに終わることが無いように。src/sync.ts）。読み直しが先に Banto の時刻を書いていれば、そのまま
      if (o.complete && o.customer_id) {
        await onOrderPaid(deps.db, shopId, o.customer_id, o.order_id, deps.now(), [
          { sql: `UPDATE orders SET banto_updated_at = ? WHERE shop_id = ? AND order_id = ? AND banto_updated_at IS NULL`, params: [HOOK_TRIGGERED, shopId, o.order_id] },
        ]);
      }
      return;
    }
    case "order.cancelled": {
      if (typeof d["order_id"] === "string") await cancelOrder(deps.db, shopId, d["order_id"]);
      return;
    }
    case "customer.deleted": {
      if (typeof d["customer_id"] === "string") await forgetCustomer(deps.db, shopId, d["customer_id"], deps.now());
      return;
    }
    case "favorite.added":
    case "favorite.removed": {
      const customerId = id(d["customer_id"]);
      const productId = id(d["product_id"]);
      if (!customerId || !productId) return;
      if (envelope.event === "favorite.added") await addFavorite(deps.db, shopId, customerId, productId, isoSeconds(envelope.created_at, deps.now()));
      else await removeFavorite(deps.db, shopId, customerId, productId);
      return;
    }
    case "product.updated": {
      const productId = id(d["product_id"]);
      if (productId) await onProductUpdated(deps, connection, productId);
      return;
    }
    case "checkout.abandoned": {
      await onCheckoutAbandoned(deps, connection, d, isoSeconds(envelope.created_at, deps.now()));
      return;
    }
    case "inventory.low": {
      const productId = id(d["product_id"]);
      const available = typeof d["available"] === "number" ? d["available"] : 0;
      if (productId) await onInventoryLow(deps, connection, productId, available, id(d["sku_id"]));
      return;
    }
    default:
      return;
  }
}
