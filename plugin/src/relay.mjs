// src/relay.mjs — loader.fetch 真正干活的地方：URL 归一、路由、转发、错误分档。
//
// 三条硬规矩：
//   1. 流式正文**一个字节都不改**。2xx 一律原样返回原 Response（stream 还在里面）。
//   2. 头只透传白名单，authorization 自己写 —— 用户代理的头可能带别的 Key。
//   3. 错误分档决定宿主要不要切账号/切模型，所以按语义改写状态码（CONTRACT §8.7）：
//      · 401（Key 失效）→ 原样 + x-magpie-sign-in: expired
//      · 402 余额不足 / 403 欠费·超限 → 429 + retry-after（让宿主切下一个账号）
//      · 403 模型不在范围 / 503 未标价 / model_not_found → 404（模型问题，别动账号）
//      · 内容审核、IP 黑名单 → 原样（不是我们的问题，也不该切号）

import { CHAT_PATH, CHAT_TIMEOUT_MS, INFER_BASE, USER_AGENT } from "./config.mjs";
import { errorResponse, jsonResponse, redact, timeoutSignal } from "./http.mjs";

const PASS_HEADERS = new Set(["accept", "content-type", "anthropic-version", "anthropic-beta"]);

/** 把 input（string | URL | {url}）与 init 归一成 {url, method, headers}。 */
export function normalizeRequest(input, init) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
  const url = String(raw || "");
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
  const source = init?.headers ?? input?.headers;
  const headers = source instanceof Headers ? new Headers(source) : new Headers(Object.entries(source || {}).flatMap(([k, v]) => (v === undefined || v === null ? [] : [[k, String(v)]])));
  return { url, method, headers };
}

/**
 * 从完整 URL 里取「相对 /v1 的尾巴」。
 * loader.baseURL 自带 /v1，而 Anthropic SDK 的 base_url 惯例不带 /v1，
 * 所以两种拼法都要落到同一个 tail 上，否则会出 /v1/v1/messages。
 */
export function tailOf(url) {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url || "").replace(/^https?:\/\/[^/]+/, "");
  }
  // bypass 路径必须优先：它自带 /v1/ 段，先判 /v1/ 会把 /bypass/anthropic/v1/messages
  // 截成 /messages，令 targetOf 的 bypass 分支成为死代码、Anthropic 透传走错域。
  if (path.startsWith("/bypass/")) return path;
  const at = path.indexOf("/v1/");
  if (at >= 0) return path.slice(at + 3);
  if (path === "/v1") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function isChatPath(tail) {
  return tail === CHAT_PATH || tail === `${CHAT_PATH}/` || tail.startsWith(`${CHAT_PATH}?`);
}

export function isModelsPath(tail) {
  return tail === "/models" || tail === "/models/" || tail.startsWith("/models?");
}

/** 目标 URL：一律打 api.qnaigc.com，路径用归一后的 tail，绝不叠两个 /v1。 */
export function targetOf(tail, base = INFER_BASE) {
  const root = String(base || INFER_BASE).replace(/\/+$/, "");
  const clean = tail.startsWith("/") ? tail : `/${tail}`;
  if (clean.startsWith("/bypass/")) return `${root.replace(/\/v1$/, "")}${clean}`;
  return `${root}${clean}`;
}

export function filterHeaders(headers) {
  const out = new Headers();
  if (!headers || typeof headers.forEach !== "function") {
    out.set("accept", "text/event-stream");
    out.set("content-type", "application/json");
    out.set("user-agent", USER_AGENT);
    return out;
  }
  headers.forEach((value, key) => {
    if (PASS_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  if (!out.has("accept")) out.set("accept", "text/event-stream");
  if (!out.has("content-type")) out.set("content-type", "application/json");
  out.set("user-agent", USER_AGENT);
  return out;
}

/** 本地直接回模型表（不联网）：magpie 的模型列表探测会打到 GET /models。 */
export function modelsResponse(table) {
  const data = Object.keys(table).map((id) => ({ id, object: "model", owned_by: "qiniu", created: 0 }));
  return jsonResponse({ object: "list", data }, { headers: { "cache-control": "no-store" } });
}

export function notImplemented(path) {
  return errorResponse(501, `该接口七牛不支持：${path}。本插件只代理 /chat/completions、/messages 与 /models`, "invalid_request_error", "not_implemented");
}

// ---- 错误分档 ---------------------------------------------------------------
const RULES = [
  {
    // 上游 503 且「模型没标价」= 模型 id 写错/该模型未开通，改判 404，别让宿主当服务端故障反复切号
    match: (s, t) => s === 503 && /price of the model is not set/i.test(t),
    to: () => ({ status: 404, code: "model_not_priced", type: "not_available_error", signIn: "kept",
      message: "这个模型在七牛侧没有标价（通常说明模型 id 写错或该模型未对你开通）" }),
  },
  {
    match: (s, t) => s === 402,
    to: (t) => ({ status: 429, code: "balance_insufficient", type: "insufficient_quota", retryAfter: 900,
      message: `七牛账户余额或资源包不足，充值后约 15 分钟恢复。原始错误：${clip(t)}` }),
  },
  {
    match: (s, t) => s === 403 && /request not allowed|arrears|欠费/i.test(t),
    to: (t) => ({ status: 429, code: "arrears", type: "insufficient_quota", retryAfter: 1200,
      message: `七牛账户处于欠费受限状态，结清后约 20 分钟自动解除。原始错误：${clip(t)}` }),
  },
  {
    match: (s, t) => (s === 403 || s === 400) && /quota exceeded|monthly quota|额度已用尽|超限/i.test(t),
    to: (t) => ({ status: 429, code: "quota_exceeded", type: "insufficient_quota", retryAfter: 1200,
      message: `这把 Key 的额度已用尽，可在七牛控制台调整或换一把 Key。原始错误：${clip(t)}` }),
  },
  {
    match: (s, t) => /not available in your assigned model groups|no active subscription includes this model|subscription/i.test(t) && s >= 400 && s < 500,
    to: (t) => ({ status: 404, code: "model_out_of_scope", type: "not_available_error", signIn: "kept",
      message: `该模型不在你这个账号/订阅的范围内。原始错误：${clip(t)}` }),
  },
  {
    match: (s, t) => (s === 400 || s === 403 || s === 404) && /model_not_found|is not available|模型不支持|模型不存在|no such model/i.test(t),
    to: (t) => ({ status: 404, code: "model_not_found", type: "not_available_error", signIn: "kept",
      message: `上游没有这个模型或暂不可用。原始错误：${clip(t)}` }),
  },
];

function clip(text, n = 240) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 判断一个非 2xx 响应该怎么回。
 * @returns {{pass:true, signIn?:string} | {pass:false, status:number, body:object, headers:Record<string,string>}}
 */
export function classifyResponse(status, text, options = {}) {
  const quotaFailover = options.quotaFailover !== false;
  const raw = String(text || "");
  // 401：Key 失效 → 原样透传 + expired（宿主据此标记账号）
  if (status === 401) {
    const missing = /auth_api_key_missing|No valid authentication credentials/i.test(raw);
    if (missing) {
      // 我们自己没把 Key 贴上去，属于插件故障，别污染账号状态
      return {
        pass: false,
        status: 500,
        body: { error: { message: "插件没能把 Key 附到请求上（auth_api_key_missing）", type: "magpie_error", code: "missing_credential" } },
        headers: {},
      };
    }
    return { pass: true, signIn: "expired" };
  }
  // 内容审核 / IP 黑名单 / 其余 4xx：原样给用户看，不切号
  for (const rule of RULES) {
    if (!rule.match(status, raw)) continue;
    const mapped = rule.to(raw);
    if (!quotaFailover && (mapped.status === 429)) continue;
    return {
      pass: false,
      status: mapped.status,
      body: { error: { message: mapped.message, type: mapped.type, code: mapped.code } },
      headers: mapped.retryAfter ? { "retry-after": String(mapped.retryAfter) } : {},
      signIn: mapped.signIn,
    };
  }
  return { pass: true };
}

/**
 * 转发一次聊天请求。
 * @returns {Promise<Response>}
 */
export async function forwardChat({ url, method = "POST", headers, body, apiKey, signal, timeoutMs = CHAT_TIMEOUT_MS, fetchImpl, options = {} }) {
  const outHeaders = filterHeaders(headers);
  if (apiKey) outHeaders.set("authorization", `Bearer ${apiKey}`);
  const doFetch = fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await doFetch(url, {
      method,
      headers: outHeaders,
      body,
      signal: timeoutSignal(timeoutMs, signal),
      redirect: "follow",
    });
  } catch (e) {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") {
      return errorResponse(499, `请求被取消或超时（${Math.round(timeoutMs / 1000)}s）`, "timeout_error", "client_closed_request");
    }
    return errorResponse(502, `连不上七牛：${redact(String(e?.message || e))}`, "api_connection_error", "upstream_unreachable");
  }

  if (response.ok) return response;

  // 非 2xx：错误体很小，读成文本再决定怎么回；流式正文在 2xx 分支已经原样返回，不受影响
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  const verdict = classifyResponse(response.status, text, options);
  if (verdict.pass) {
    const headersOut = new Headers(response.headers);
    if (verdict.signIn) headersOut.set("x-magpie-sign-in", verdict.signIn);
    return new Response(text, { status: response.status, statusText: response.statusText, headers: headersOut });
  }
  const headersOut = { ...(verdict.headers || {}) };
  if (verdict.signIn) headersOut["x-magpie-sign-in"] = verdict.signIn;
  return jsonResponse(verdict.body, { status: verdict.status, headers: headersOut });
}

/** 从任意 auth 形状里取可用 Key（sk- Key 优先，AK/SK 无法直接当推理凭据）。 */
export function apiKeyOf(auth) {
  if (!auth || typeof auth !== "object") return "";
  for (const key of ["apiKey", "key"]) {
    const v = auth[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export { PASS_HEADERS };
