import { describe, expect, it } from "vitest";
import { open, seal } from "../src/crypto";
import { verifyHookSignature, verifyPluginTicket } from "../src/banto/signing";
import { signHook, signPluginTicket } from "./helpers";

describe("暗号の箱", () => {
  it("同じ秘密と aad なら開ける", async () => {
    const box = await seal("s".repeat(40), "token:a:b", "banto_xxx");
    expect(box).not.toContain("banto_xxx");
    expect(await open("s".repeat(40), "token:a:b", box)).toBe("banto_xxx");
  });
  it("aad が違う・秘密が違う・壊れている箱は開けない", async () => {
    const box = await seal("s".repeat(40), "token:a:b", "banto_xxx");
    expect(await open("s".repeat(40), "token:a:c", box)).toBeNull();
    expect(await open("t".repeat(40), "token:a:b", box)).toBeNull();
    expect(await open("s".repeat(40), "token:a:b", box.slice(0, -2))).toBeNull();
    expect(await open("s".repeat(40), "token:a:b", "v2.x.y")).toBeNull();
  });
});

describe("hooks の署名（Banto の docs/hooks.md §3）", () => {
  const secret = "b".repeat(64);
  it("正しい署名は通る", async () => {
    const body = '{"id":"x"}';
    expect(await verifyHookSignature(secret, body, await signHook(secret, body, 1000), 1000)).toBe(true);
  });
  it("本文が違う・5 分を過ぎた・形が違うものは断る", async () => {
    const body = '{"id":"x"}';
    const h = await signHook(secret, body, 1000);
    expect(await verifyHookSignature(secret, '{"id":"y"}', h, 1000)).toBe(false);
    expect(await verifyHookSignature(secret, body, h, 1301)).toBe(false);
    expect(await verifyHookSignature(secret, body, "t=1000", 1000)).toBe(false);
    expect(await verifyHookSignature(secret, body, null, 1000)).toBe(false);
  });
});

describe("管理画面の券 banto_ticket（docs/hooks.md §6）", () => {
  const secret = "c".repeat(64);
  const claims = { shop_id: "s1", endpoint_id: "e1", user_id: "u1" };
  it("Banto が作った券を読める", async () => {
    const t = await signPluginTicket(secret, claims, 1000);
    expect(await verifyPluginTicket(secret, t, 1000)).toEqual({ ...claims, exp: 1300 });
  });
  it("期限切れ・別のシークレット・書き換えた券は断る", async () => {
    const t = await signPluginTicket(secret, claims, 1000);
    expect(await verifyPluginTicket(secret, t, 1301)).toBeNull();
    expect(await verifyPluginTicket("d".repeat(64), t, 1000)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ ...claims, shop_id: "s2", exp: 1300 })).replace(/=+$/, "");
    expect(await verifyPluginTicket(secret, `${forged}.${sig}`, 1000)).toBeNull();
    expect(body).toBeTruthy();
  });
});
