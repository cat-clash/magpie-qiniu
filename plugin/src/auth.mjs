// src/auth.mjs — 登录（凭据校验）、账号命名，以及 AK/SK → sk- Key 的自动签发。
//
// 硬规矩：
//   · 不发可能挂很久的请求（校验用 VERIFY_TIMEOUT_MS）。
//   · 不在日志/错误里出现明文 Key：一律 maskKey。
//   · 校验失败要能区分「Key 无效」和「网络不通」，但都不许把账号写成登录态。
//   · 登录对象是宿主的成功形状：{type:"success", access, refresh, expires, accountId, uid, …}
//     七牛没有 OAuth，所以 access/refresh 恒为空串、expires 恒 0（= 不会自动过期）。

import { API_TIMEOUT_MS, MODELS_PATH, PORTAL_URL, USAGE_SERIES_PATH, VERIFY_TIMEOUT_MS } from "./config.mjs";
import { ApiError, apiFetch, errorText, isAbort, maskKey } from "./http.mjs";
import { keyFingerprint } from "./cache-key.mjs";
import { qiniuAuthHeader } from "./sign.mjs";
import { fetchBalanceOverview, fetchUsageSeries, createInferenceKey } from "./usage-api.mjs";

const KEY_RE = /^(sk|tk)-[A-Za-z0-9_\-]{8,}$/;

export function looksApiKey(value) {
  return typeof value === "string" && KEY_RE.test(value.trim());
}

export function looksAkskPair(accessKey, secretKey) {
  return typeof accessKey === "string" && typeof secretKey === "string" && accessKey.trim().length >= 16 && secretKey.trim().length >= 16;
}

/** 账号显示名：必须是非空字符串，magpie 用它做下拉列表的标签。 */
export function accountLabelOf(input = {}) {
  const candidates = [input.label, input.email, input.accountId, input.name];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 60);
  }
  return "七牛云账号";
}

export function uidOf(input = {}) {
  const explicit = typeof input.uid === "string" ? input.uid.trim() : "";
  if (explicit) return explicit;
  // 有凭据才算指纹；空对象必须走 acc_ 随机 id，别把 ":" 的哈希当 key 指纹
  if (input.apiKey) return `key_${keyFingerprint(input.apiKey)}`;
  if (input.accessKey && input.secretKey) return `aksk_${keyFingerprint(`${input.accessKey}:${input.secretKey}`)}`;
  return `acc_${Math.random().toString(36).slice(2, 10)}`;
}

/** 宿主成功对象。七牛没有刷新令牌，所以 refresh/access 为空、expires=0。 */
export function successAuth(fields) {
  const accountId = accountLabelOf(fields);
  const uid = uidOf(fields);
  const out = {
    type: "success",
    access: "",
    refresh: "",
    expires: 0,
    accountId,
    uid,
    provider: fields.provider,
    mode: fields.mode || (fields.accessKey ? "aksk" : "key"),
  };
  if (fields.apiKey) out.apiKey = fields.apiKey;
  if (fields.accessKey) out.accessKey = fields.accessKey;
  if (fields.secretKey) out.secretKey = fields.secretKey;
  if (fields.email) out.email = String(fields.email).slice(0, 120);
  if (fields.keyLabel) out.keyLabel = String(fields.keyLabel).slice(0, 40);
  if (fields.note) out.note = String(fields.note).slice(0, 200);
  out.verifiedAt = Date.now();
  return out;
}

/**
 * 校验 sk-/tk- Key：GET /v1/models 带 Bearer。
 * 实测（research/upstream-probe.md §1）：无 Key 是 200，带坏 Key 是 401
 * `auth_api_key_invalid`，所以「带 Key 拿到 200」才说明这把 Key 真的有效。
 */
export async function verifyApiKey({ apiKey, inferOrigin, fetchImpl, signal, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!looksApiKey(key)) {
    return { ok: false, reason: "Key 形态不对：应以 sk- 或 tk- 开头", code: "shape" };
  }
  // inferOrigin 既可能是 origin（https://api.qnaigc.com）也可能是 base（…/v1）；两种都收敛到 /v1/models
  const origin = (inferOrigin || "").replace(/\/+$/, "");
  const url = origin.endsWith("/v1") ? `${origin}${MODELS_PATH}` : `${origin}/v1${MODELS_PATH}`;
  try {
    const response = await apiFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      timeoutMs,
      signal,
      fetchImpl,
    });
    if (response.status === 200) {
      let count = 0;
      try {
        const body = await response.json();
        count = Array.isArray(body?.data) ? body.data.length : 0;
      } catch {
        count = 0;
      }
      return { ok: true, models: count };
    }
    const error = await safeErrorOf(response);
    return { ok: false, reason: describeAuthFailure(response.status, error), code: error?.code || String(response.status), status: response.status };
  } catch (e) {
    if (isAbort(e)) return { ok: false, reason: "校验被取消", code: "aborted" };
    return { ok: false, reason: `连不上七牛（${errorText(e)}）`, code: "network" };
  }
}

/** 校验 AK/SK：用余额接口做一次签名 GET（极小体量，且只有 AK/SK 能查）。 */
export async function verifyAksk({ accessKey, secretKey, billingOrigin, fetchImpl, signal, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const account = { mode: "aksk", accessKey: String(accessKey || "").trim(), secretKey: String(secretKey || "").trim() };
  if (!looksAkskPair(account.accessKey, account.secretKey)) {
    return { ok: false, reason: "AK/SK 形态不对：两者都应是 16 位以上的字母数字串", code: "shape" };
  }
  try {
    const { data } = await fetchBalanceOverview({
      account,
      sign: qiniuAuthHeader,
      fetchImpl,
      signal,
      timeoutMs,
      origin: billingOrigin,
    });
    return { ok: true, data };
  } catch (e) {
    if (isAbort(e)) return { ok: false, reason: "校验被取消", code: "aborted" };
    const status = Number(e?.status) || 0;
    const text = errorText(e);
    if (status === 401 || /invalid ak\/sk sign|invalid user|authorization/i.test(text)) {
      return { ok: false, reason: "AK/SK 签名不通过：请确认两个框没填反（第 1 步应填 AccessKey、第 2 步应填 SecretKey），再检查是否复制完整", code: "aksk_invalid", status };
    }
    return { ok: false, reason: `校验 AK/SK 失败：${text}`, code: "network", status };
  }
}

async function safeErrorOf(response) {
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      return body?.error || body;
    } catch {
      return { message: text.slice(0, 200) };
    }
  } catch {
    return undefined;
  }
}

function describeAuthFailure(status, error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (status === 401 && code === "auth_api_key_missing") return "请求没带上 Key，检查是否放在了 Authorization 里";
  if (status === 401) return `Key 无效或已删除（${message || "401"}）`;
  if (status === 403) return `这把 Key 没有权限（${message || "403"}）`;
  if (status === 429) return "校验太频繁，被限流了，稍后再试";
  return `校验失败（HTTP ${status}${message ? `：${message}` : ""}）`;
}

/**
 * sk-/tk- Key 登录。只有校验通过才返回 success；否则 failed（error 会被宿主播给用户）。
 * @param {{apiKey:string,label?:string,keyLabel?:string}} inputs
 */
export async function keyOnlyLogin(inputs = {}, context = {}) {
  const apiKey = String(inputs.apiKey || inputs.key || "").trim();
  if (!apiKey) return { type: "failed", error: "请填写七牛云 API Key（sk- 开头）" };
  const verified = await verifyApiKey({
    apiKey,
    inferOrigin: context.inferOrigin,
    fetchImpl: context.fetchImpl,
    signal: context.signal,
  });
  if (!verified.ok) {
    return { type: "failed", error: `${verified.reason}。Key 在 ${PORTAL_URL} 申请` };
  }
  const label = accountLabelOf({ label: inputs.label || inputs.keyLabel, apiKey });
  const suffix = keyFingerprint(apiKey).slice(0, 4);
  return successAuth({
    provider: context.provider,
    mode: "key",
    apiKey,
    keyLabel: inputs.keyLabel || inputs.label || "",
    accountId: inputs.label ? label : `七牛云 ${maskKey(apiKey)}`,
    uid: `key_${keyFingerprint(apiKey)}`,
    note: verified.models ? `校验通过，上游当前 ${verified.models} 个模型（#${suffix}）` : `校验通过（#${suffix}）`,
  });
}

/**
 * AK/SK 登录：校验签名 → 顺手签发一把 sk- Key（拿不到也没关系，账号仍可用 AK/SK 查用量）。
 * @param {{accessKey:string,secretKey:string,label?:string,createKey?:boolean}} inputs
 */
export async function akskLogin(inputs = {}, context = {}) {
  const accessKey = String(inputs.accessKey || inputs.ak || "").trim();
  const secretKey = String(inputs.secretKey || inputs.sk || "").trim();
  if (!accessKey || !secretKey) return { type: "failed", error: "AK 和 SK 都要填（七牛控制台 → 密钥管理）" };
  const verified = await verifyAksk({ accessKey, secretKey, billingOrigin: context.billingOrigin, fetchImpl: context.fetchImpl, signal: context.signal });
  if (!verified.ok) return { type: "failed", error: verified.reason };

  const email = String(verified.data?.email || "").trim();
  const accountId = inputs.label || email || `七牛云 AK ${accessKey.slice(0, 6)}…`;

  // 自动签发 sk- Key：这是可选增强，失败不阻断登录（CONTRACT 硬规矩 ③）
  let apiKey = "";
  let note = "";
  if (inputs.createKey !== false) {
    try {
      const created = await createInferenceKey({
        account: { mode: "aksk", accessKey, secretKey, accountId },
        name: String(inputs.keyLabel || `magpie-${new Date().toISOString().slice(0, 10)}`).slice(0, 40),
        sign: qiniuAuthHeader,
        fetchImpl: context.fetchImpl,
        signal: context.signal,
        timeoutMs: API_TIMEOUT_MS,
      });
      if (created?.key) {
        apiKey = created.key;
        note = `已为你签发 sk- Key ${created.apiKeyMasked || maskKey(created.key)}`;
      }
    } catch (e) {
      note = `AK/SK 登录成功，但自动签发 sk- Key 失败：${errorText(e)}（可在 ${PORTAL_URL} 手动创建后改用 Key 登录）`;
    }
  }

  const auth = successAuth({
    provider: context.provider,
    mode: "aksk",
    accessKey,
    secretKey,
    apiKey,
    email,
    accountId,
    uid: `aksk_${keyFingerprint(`${accessKey}:${secretKey}`)}`,
    note,
  });
  return auth;
}

/** 统一入口：按输入里有哪些字段决定走哪条登录链路。 */
export async function login(inputs = {}, context = {}) {
  const apiKey = String(inputs.apiKey || inputs.key || "").trim();
  if (apiKey) return keyOnlyLogin({ ...inputs, apiKey }, context);
  if (inputs.accessKey || inputs.ak) return akskLogin(inputs, context);
  return { type: "failed", error: `请填 sk- Key，或用 AK/SK 免创建 Key 直接登录（申请地址 ${PORTAL_URL}）` };
}

/**
 * 给已有账号补一把 Key（批量导入到已有 AK/SK 账号时用）——只算内存补丁，
 * 真源仍在宿主：调用方决定是否把返回值写回。
 */
export function applyCredentialPatch(auth, patch = {}) {
  const next = { ...(auth || {}) };
  for (const key of ["apiKey", "accessKey", "secretKey", "keyLabel", "email", "accountId", "note"]) {
    if (patch[key] !== undefined && patch[key] !== "") next[key] = patch[key];
  }
  if (next.accessKey && next.secretKey) next.mode = "aksk";
  else if (next.apiKey) next.mode = "key";
  next.verifiedAt = Date.now();
  return next;
}

/** 判断这个账号是否够用（没有 Key 且没有 AK/SK 就是空的）。 */
export function isUsableAuth(auth) {
  if (!auth || typeof auth !== "object") return false;
  return Boolean(auth.apiKey || (auth.accessKey && auth.secretKey));
}

export { USAGE_SERIES_PATH, ApiError };
