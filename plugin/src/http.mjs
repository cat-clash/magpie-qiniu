// 通用 HTTP / 错误 / 脱敏工具。除 config.mjs 外零依赖。
import { API_TIMEOUT_MS, USER_AGENT } from "./config.mjs";

export class ApiError extends Error {
  constructor(message, init = {}) {
    super(String(message ?? "请求失败"));
    this.name = "ApiError";
    this.status = Number(init.status) || 0;
    this.code = typeof init.code === "string" ? init.code : "";
    this.type = typeof init.type === "string" ? init.type : "";
    this.body = init.body ?? null;
    this.signIn = typeof init.signIn === "string" ? init.signIn : "";
    if (init.cause) this.cause = init.cause;
  }
}

export const abortError = (message = "已取消") =>
  Object.assign(new Error(message), { name: "AbortError" });

export function isAbort(e) {
  return e?.name === "AbortError" || e?.code === "ABORT_ERR" || String(e?.message ?? "").includes("aborted");
}

/** 可中断的 sleep；signal 触发时立刻 reject AbortError。 */
export function sleep(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(wait);
    }, wait);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers ?? undefined);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

/** 与上游同构的错误外壳：{"error":{"message","type","code"}} */
export function errorResponse(status, message, type = "api_error", code = "", headers = {}) {
  return jsonResponse({ error: { message: String(message ?? ""), type: type || "api_error", code: code || "" } }, { status, headers });
}

const REDACT_RULES = [
  // sk- / tk- / 以及示例占位形态（允许花括号，方便测试里的假值也被遮蔽）
  [/\b(sk|tk)-([A-Za-z0-9_\-{}]{4,})\b/gi, (_m, p, s) => `${p}-${maskTail(s, 4)}`],
  // Qiniu <AK>:<signature>
  [/\bQiniu\s+([A-Za-z0-9_\-{}]{4,}):([A-Za-z0-9_+=\-\/{}]{4,})\b/g, (_m, ak) => `Qiniu ${maskTail(ak, 3)}:****`],
  // 裸 AK:SK 形态
  [/([A-Za-z0-9]{12,40}):([A-Za-z0-9]{16,60})/g, (_m, ak) => `${maskTail(ak, 3)}:****`],
  // JWT
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, () => "jwt:****"],
  // 长 hex / 长 base64 片段
  [/\b[0-9a-f]{28,}\b/gi, (m) => maskTail(m, 6)],
  // key=value 形态的机密字段
  [
    /(["']?(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?key|access[_-]?secret|token|authorization|password)["']?\s*[:=]\s*["']?)([^\s"',;}&]{4,})/gi,
    (_m, head) => `${head}****`,
  ],
];

function maskTail(str, keep) {
  const s = String(str ?? "");
  if (s.length <= keep + 2) return "*".repeat(Math.max(3, s.length));
  return `${s.slice(0, keep)}…${s.slice(-2)}`;
}

/** 日志与错误文案里出现的一切凭据都必须先过这里。 */
export function redact(value) {
  let text = typeof value === "string" ? value : value == null ? "" : String(safeStringify(value));
  for (const [re, rep] of REDACT_RULES) text = text.replace(re, rep);
  return text;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 只保留前 6 后 4，用于账号显示名（不是日志脱敏，是「本来就只存摘要」）。 */
export function maskKey(value, head = 6, tail = 4) {
  const s = String(value ?? "");
  if (s.length <= head + tail) return "*".repeat(Math.max(4, s.length));
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function errorText(error) {
  if (!error) return "未知错误";
  if (error instanceof ApiError) {
    const parts = [error.message];
    if (error.code) parts.push(`code=${error.code}`);
    if (error.status) parts.push(`http=${error.status}`);
    return parts.join(" · ");
  }
  const nested = error?.error?.message ?? error?.response?.data?.error?.message;
  if (typeof nested === "string" && nested) return redact(nested);
  return redact(String(error?.message ?? error));
}

/** AbortSignal.timeout + 外部 signal 的合成；老运行时退回手工 controller。 */
export function timeoutSignal(timeoutMs, signal) {
  const ms = Math.max(1, Number(timeoutMs) || API_TIMEOUT_MS);
  if (typeof AbortSignal === "undefined") return signal ?? undefined;
  const timer = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : null;
  if (!timer) return signal ?? undefined;
  if (!signal) return timer;
  if (typeof AbortSignal.any === "function") {
    try {
      return AbortSignal.any([timer, signal]);
    } catch {
      /* 落到手工合成 */
    }
  }
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (timer.aborted) abort(timer.reason);
  else timer.addEventListener?.("abort", () => abort(timer.reason), { once: true });
  if (signal.aborted) abort(signal.reason);
  else signal.addEventListener?.("abort", () => abort(signal.reason), { once: true });
  return controller.signal;
}

/** 从上游响应构造 ApiError：兼容 OpenAI 外壳、七牛 {status:false,error} 外壳、纯文本。 */
export function apiErrorFromResponse(response, payload, rawText) {
  const status = response?.status ?? 0;
  const body = payload ?? (rawText ? { raw: String(rawText).slice(0, 400) } : null);
  const openai = body?.error;
  let message =
    (typeof openai === "string" ? openai : openai?.message) ??
    (typeof body?.error === "string" ? body.error : body?.error?.message) ??
    body?.message ??
    body?.msg ??
    (typeof body === "string" ? body : "") ??
    "";
  if (!message) message = `上游返回 HTTP ${status}`;
  const type = (typeof openai === "object" && openai?.type) || body?.type || "";
  const code = (typeof openai === "object" && String(openai?.code ?? "")) || String(body?.code ?? "");
  const error = new ApiError(redact(String(message)), { status, type, code, body });
  const auth = classifyAuthError(status, error, body);
  if (auth) error.signIn = auth;
  return error;
}

const AUTH_HINTS = [
  "invalid api key",
  "invalid api_key",
  "auth_api_key_invalid",
  "authentication_error",
  "unauthorized",
  "未授权",
  "签名",
  "sign",
  "token expired",
  "apikey has been deleted",
  "key 已删除",
  "key 不存在",
];

const NOT_AUTH_HINTS = ["not allowed", "quota", "balance", "余额", "欠费", "model groups", "not available", "price", "billing", "suspend", "overdue", "停用"];

/** 只有「凭据本身不行」才返回 expired；欠费/限额/模型不可用绝不标记登录失效。 */
export function classifyAuthError(status, error, body) {
  const text = `${error?.code ?? ""} ${error?.type ?? ""} ${error?.message ?? ""} ${
    typeof body?.error === "string" ? body.error : body?.error?.code ?? ""
  }`.toLowerCase();
  if (status === 401) {
    if (NOT_AUTH_HINTS.some((h) => text.includes(h)) && !AUTH_HINTS.some((h) => text.includes(h))) return "";
    return "expired";
  }
  if (status === 403 && AUTH_HINTS.some((h) => text.includes(h)) && !NOT_AUTH_HINTS.some((h) => text.includes(h))) {
    return "expired";
  }
  return "";
}

/**
 * 小请求的统一入口：带超时、统一错误、统一脱敏。
 * 返回 { status, headers, data, text }。
 */
export async function apiFetch(url, init = {}) {
  const { timeoutMs = API_TIMEOUT_MS, signal, headers, method = "GET", body, fetchImpl } = init;
  const finalSignal = timeoutSignal(timeoutMs, signal);
  const doFetch = fetchImpl ?? fetch;
  let response;
  try {
    response = await doFetch(url, {
      method,
      body,
      signal: finalSignal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(headers ?? {}),
      },
    });
  } catch (e) {
    if (isAbort(e) && signal?.aborted) throw abortError();
    throw new ApiError(`请求失败：${errorText(e)}`, { status: 0, cause: e });
  }
  const text = await response.text().catch(() => "");
  const data = parseJson(text);
  if (!response.ok) throw apiErrorFromResponse(response, data, text);
  // 七牛外壳：{"status":false,"error":"…"} 也可能带 HTTP 200
  if (data && data.status === false) {
    const message = typeof data.error === "string" ? data.error : data?.error?.message ?? "上游返回 status=false";
    throw new ApiError(redact(String(message)), { status: response.status, code: String(data?.code ?? ""), body: data });
  }
  return { status: response.status, headers: response.headers, data, text };
}

/** 在任意 JSON 结构里找第一个命中 keys 的标量，容忍上游改字段名。 */
export function deepFind(value, keys, depth = 0) {
  if (!value || depth > 6) return null;
  if (typeof value !== "object") return null;
  for (const key of keys) {
    const hit = value[key];
    if (typeof hit === "string" || typeof hit === "number" || typeof hit === "boolean") return hit;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = deepFind(child, keys, depth + 1);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}
