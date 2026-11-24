// src/cache-key.mjs — 账号指纹 + prompt_cache_key（只依赖 node:crypto，别处不许再抄一份）。
// keyFingerprint 放这里是因为 auth / live-auth / bulk-import 都要用，绕开循环 import。

import { createHash } from "node:crypto";

const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const p of content) {
    if (typeof p === "string") out.push(p);
    else if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (p?.type === "image_url") out.push(String(p.image_url?.url ?? "").slice(0, 256));
  }
  return out.filter(Boolean).join(" ");
}

/**
 * 上游文档里没有 prompt_cache_key 这个字段（CONTRACT §8.6），所以默认不注入。
 * 开启后也只取 model + system/developer + 首条 user 拼稳定串，不递归整棵 messages 树。
 */
export function promptCacheKey(body) {
  const model = typeof body?.model === "string" ? body.model : "";
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let system = "";
  let firstUser = "";
  for (const m of messages) {
    const text = contentToText(m?.content);
    if ((m?.role === "system" || m?.role === "developer") && text) system += " " + text;
    else if (!firstUser && m?.role === "user" && text) firstUser = text.slice(0, 1024);
  }
  return sha1([model, system.slice(0, 4096), firstUser].join(String.fromCharCode(10)));
}

/** 凭据指纹：同一把 Key 在不同登录方式下必须落同一个值，否则批量导入会造重复账号。 */
export function keyFingerprint(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? sha1(s).slice(0, 12) : "";
}

export { contentToText };
