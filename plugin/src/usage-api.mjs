// plugin/src/usage-api.mjs —— 七牛「用量 / 费用 / 余额 / Key 限额」接口封装层（A3）
//
// 设计约束（CONTRACT.md §0/§1/§3）：
//   · 零 import：不依赖 src/sign.mjs（A2 并行，接口未定稿），也不依赖 src/http.mjs。
//   · AK/SK 签名一律走注入的 `sign`（= deps.sign）回调：
//       sign({ method, url, contentType, body, accessKey, secretKey }) -> Authorization 头值
//     回调也可返回 { authorization, headers } 以便带上 X-Qiniu-Date 一类的附加头。
//   · 错误统一为 UsageApiError（status / code / message / signIn?），主控读 `.signIn` 分档。
//   · 任何 message / 日志不得含完整 key 或签名：全部过 mask()/scrub()。
//   · 时间一律用带偏移的 RFC3399（默认 Asia/Shanghai → +08:00），不依赖本机时区。
//   · 本模块不出现任何「签到」概念（CONTRACT §0）。

export const DEFAULT_INFER_ORIGIN = "https://api.qnaigc.com";
export const DEFAULT_BILLING_ORIGIN = "https://api.qiniu.com";

/** `/v3/stat/usage` 官方跨度上限（天）。 */
export const GRANULARITY_MAX_DAYS = Object.freeze({ day: 31, hour: 7, week: 182, month: 366 });
/** 同 IP 5 req/s → 单次调用最小间隔（ms）。 */
export const MIN_REQUEST_INTERVAL_MS = 210;
/** 余额类字段单位：元 × 1e8（CONTRACT §1「余额单位是元×1e8」）。 */
export const BALANCE_UNIT = 1e8;

export const MASK_KEEP_HEAD = 6;
export const MASK_KEEP_TAIL = 4;

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const FALLBACK_OFFSET_MS = 8 * 3600_000; // Asia/Shanghai

// ────────────────────────────── 错误与脱敏 ──────────────────────────────

/** 统一错误对象。`signIn` 仅在错误体明确说 key 无效时为 "expired"，否则**不设该属性**。 */
export class UsageApiError extends Error {
  constructor(message, { status = 0, code = "", signIn = undefined, endpoint = "", cause = undefined } = {}) {
    super(message);
    this.name = "UsageApiError";
    this.status = Number.isFinite(status) ? status : 0;
    this.code = typeof code === "string" ? code : String(code ?? "");
    if (signIn !== undefined && signIn !== null) this.signIn = signIn;
    if (endpoint) this.endpoint = endpoint;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 只留前 6 后 4；短串整体打码。用于 key / AK / SK / 签名。 */
export function mask(value) {
  const s = value == null ? "" : typeof value === "string" ? value : String(value);
  if (!s) return "";
  if (s.length <= MASK_KEEP_HEAD + MASK_KEEP_TAIL) return "***";
  return `${s.slice(0, MASK_KEEP_HEAD)}***${s.slice(-MASK_KEEP_TAIL)}`;
}

const SECRET_KEY_RES = /\b(?:sk|tk|ak|qk)-[A-Za-z0-9._~+/=-]{6,}/gi;
const SECRET_HEADER_RES = /\b(Qiniu|Bearer|Basic|Token|Digest)\s+([A-Za-z0-9._~+/=:%-]{8,})/gi;
const MAX_MSG = 240;

/** 把任意上游文本里的密钥/签名形态替换成打码串，并限长。错误 message 只允许经过这里。 */
export function scrub(text) {
  let out = text == null ? "" : typeof text === "string" ? text : String(text);
  out = out.replace(SECRET_HEADER_RES, (_m, scheme, value) => `${scheme} ${mask(value)}`);
  out = out.replace(SECRET_KEY_RES, (m) => mask(m));
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_MSG ? `${out.slice(0, MAX_MSG)}…` : out;
}

/** 兜底脱敏：把本请求实际用到的凭证/签名原文从任意文本里彻底替换掉（防上游回显）。 */
export function bury(text, secrets = []) {
  let out = text == null ? "" : String(text);
  for (const s of secrets) {
    const v = typeof s === "string" ? s : s == null ? "" : String(s);
    if (v.length >= 6) out = out.split(v).join(mask(v));
  }
  return out;
}

// ────────────────────────────── 端点表 ──────────────────────────────

const ENDPOINT_PATH_HINTS = [
  "/stat/usage",
  "/cost-detail",
  "/export_log",
  "/apikey/quota",
  "/apikeys",
  "/balance-overview",
  "/respack/list",
];

/**
 * 端点 URL 模板。`origin` 参数可传「源站」或「完整端点 URL」，两种都能正确解析。
 * `query` 字段名是文档/推测值（见 research/usage-endpoints.md），若上游实测不同，
 * 主控可按端点传 `query` 覆盖，或直接改这里的字段名表。
 */
export function usageEndpoints({ inferOrigin = DEFAULT_INFER_ORIGIN, billingOrigin = DEFAULT_BILLING_ORIGIN } = {}) {
  const infer = stripSlash(inferOrigin || DEFAULT_INFER_ORIGIN);
  const billing = stripSlash(billingOrigin || DEFAULT_BILLING_ORIGIN);
  return {
    inferOrigin: infer,
    billingOrigin: billing,
    usage: `${infer}/v3/stat/usage`,
    apiKeyCost: `${infer}/v3/stat/usage/apikey/cost`,
    costDetail: `${infer}/v3/stat/usage/cost-detail`,
    exportLog: `${infer}/v2/stat/export_log`,
    keyQuota: `${infer}/v1/apikey/quota`,
    apikeys: `${infer}/v1/apikeys`,
    balanceOverview: `${billing}/billing-api/v1/account/balance-overview`,
    respackList: `${billing}/billing-api/v1/respack/list`,
    query: {
      usage: { from: "from", to: "to", granularity: "granularity", timezone: "timezone" },
      apiKeyCost: { type: "type" },
      costDetail: { startDate: "start_date", endDate: "end_date", grain: "granularity" },
      exportLog: { size: "size", page: "page" },
    },
  };
}

function stripSlash(v) {
  return String(v).replace(/\/+$/, "");
}

/** origin → 真实 base（丢掉 /v1 之类的推理 base 尾巴；已是端点 URL 则原样用）。 */
function resolveBase(origin, defaultOrigin, path) {
  const raw = typeof origin === "string" && origin.trim() ? origin.trim() : defaultOrigin;
  let u = null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  if (!u) return `${stripSlash(raw)}${path}`;
  if (ENDPOINT_PATH_HINTS.some((h) => u.pathname.includes(h))) return stripSlash(raw);
  return `${u.origin}${path}`;
}

// ────────────────────────────── 时间与夹紧 ──────────────────────────────

function fixedOffsetMs(tz) {
  const s = String(tz ?? "").trim();
  if (!s) return null;
  if (/^(utc|gmt|z|default)$/i.test(s)) return 0;
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(s);
  if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600_000 + Number(m[3] ?? 0) * 60_000);
  return null;
}

/** 某时刻 `ts` 在时区 `tz` 的 UTC 偏移（ms）。IANA 名走 Intl；坏值回落 +08:00。 */
export function zoneOffsetMs(tz, ts = Date.now()) {
  const fixed = fixedOffsetMs(tz);
  if (fixed !== null) return fixed;
  const name = String(tz ?? "").trim() || DEFAULT_TIMEZONE;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(ts))) if (p.type !== "literal") parts[p.type] = p.value;
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, Number(parts.hour) % 24, +parts.minute, +parts.second);
    const off = wall - Math.floor(ts / 1000) * 1000;
    return Number.isFinite(off) && Math.abs(off) < 26 * 3600_000 ? off : FALLBACK_OFFSET_MS;
  } catch {
    return FALLBACK_OFFSET_MS; // 未知 IANA 名：不猜本机时区，回落 Asia/Shanghai
  }
}

function offsetLabel(offMs) {
  if (offMs === 0) return "Z";
  const sign = offMs < 0 ? "-" : "+";
  const abs = Math.abs(offMs);
  const h = String(Math.floor(abs / 3600_000)).padStart(2, "0");
  const m = String(Math.floor((abs % 3600_000) / 60_000)).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

/** ts → 该时区的 RFC3399；`time` 传 "00:00:00"/"23:59:59" 直接覆盖时分秒。 */
function toIso(ts, offMs, time) {
  const d = new Date(ts + offMs);
  const date = `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  if (time) return `${date}T${time}${offsetLabel(offMs)}`;
  const hms = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  return `${date}T${hms}${offsetLabel(offMs)}`;
}

function startOfDayUtc(ts, offMs) {
  const d = new Date(ts + offMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offMs;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

function pickEnum(value, allowed, fallback) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(v) ? v : fallback;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 把 "YYYY-MM-DD" / Date / 毫秒 归一为该时区的日期串。 */
function toDateKey(value, offMs, fallbackTs) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return toIso(value.getTime(), offMs).slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) return toIso(value, offMs).slice(0, 10);
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return toIso(t, offMs).slice(0, 10);
  }
  return toIso(fallbackTs, offMs).slice(0, 10);
}

function daySpan(startKey, endKey) {
  const a = Date.parse(`${startKey}T00:00:00Z`);
  const b = Date.parse(`${endKey}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400_000) + 1);
}

/** 夹紧跨度：把 [start,end] 收到 `cap` 天内（保留 end，向前截 start）。 */
function clampRange(startKey, endKey, cap) {
  const span = daySpan(startKey, endKey);
  if (span <= cap) return { start: startKey, end: endKey, span, clamped: false };
  const endTs = Date.parse(`${endKey}T00:00:00Z`);
  return { start: toIso(endTs - (cap - 1) * 86400_000, 0).slice(0, 10), end: endKey, span: cap, clamped: true };
}

// ────────────────────────────── 鉴权 ──────────────────────────────

function readAccount(account) {
  const a = account && typeof account === "object" ? account : {};
  const mode = a.mode === "aksk" || (!a.mode && a.accessKey && a.secretKey && !a.apiKey) ? "aksk" : "key";
  return {
    mode,
    apiKey: typeof a.apiKey === "string" ? a.apiKey.trim() : "",
    accessKey: typeof a.accessKey === "string" ? a.accessKey.trim() : "",
    secretKey: typeof a.secretKey === "string" ? a.secretKey.trim() : "",
    accountId: a.accountId == null ? "" : String(a.accountId),
    uid: a.uid == null ? "" : String(a.uid),
  };
}

async function authHeaders({ acct, sign, method, url, contentType, body, endpoint }) {
  if (acct.mode === "aksk") {
    if (!acct.accessKey || !acct.secretKey) {
      throw new UsageApiError(`账号缺少 AccessKey/SecretKey，无法调用 ${endpoint}`, { status: 0, code: "aksk_required" });
    }
    if (typeof sign !== "function") {
      // 关键：不写 signIn —— 缺签名回调是接线问题，绝不能让主控把账号标成失效。
      throw new UsageApiError(`未注入 sign 回调，无法为 ${endpoint} 生成 Qiniu 签名`, { status: 0, code: "sign_callback_missing" });
    }
    let signed;
    try {
      signed = await sign({ method, url, contentType, body, accessKey: acct.accessKey, secretKey: acct.secretKey });
    } catch (err) {
      throw new UsageApiError(`${endpoint} 签名失败：${scrub(err && err.message)}`, { status: 0, code: "sign_failed", cause: err });
    }
    const out = { accept: "application/json" };
    if (typeof signed === "string") {
      if (!signed.trim()) throw new UsageApiError(`${endpoint} 签名返回空值`, { status: 0, code: "sign_empty" });
      out.authorization = signed.trim();
    } else if (signed && typeof signed === "object") {
      const auth = signed.authorization || signed.Authorization || (signed.headers && (signed.headers.authorization || signed.headers.Authorization)) || "";
      if (!auth) throw new UsageApiError(`${endpoint} 签名返回缺少 Authorization`, { status: 0, code: "sign_empty" });
      out.authorization = String(auth);
      const extra = signed.headers;
      if (extra && typeof extra === "object") {
        for (const [k, v] of Object.entries(extra)) {
          const lk = k.toLowerCase();
          if (lk === "authorization" || lk === "host" || lk === "content-length") continue;
          out[lk] = String(v);
        }
      }
    } else {
      throw new UsageApiError(`${endpoint} 签名返回值不可用`, { status: 0, code: "sign_bad_result" });
    }
    if (contentType) out["content-type"] = contentType;
    return out;
  }
  if (!acct.apiKey) {
    throw new UsageApiError(`账号缺少 API Key，无法调用 ${endpoint}`, { status: 0, code: "api_key_required" });
  }
  const out = { accept: "application/json", authorization: `Bearer ${acct.apiKey}` };
  if (contentType) out["content-type"] = contentType;
  return out;
}

// ────────────────────────────── 限流闸门 ──────────────────────────────

const gates = new Map(); // base -> { last: number, tail: Promise }

function sleepMs(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** 同一源站串行 + 最小间隔，避免 /v3/stat/usage 的 5 req/s 触发 429。 */
async function gate(base, enabled, minIntervalMs, fn) {
  if (!enabled) return fn();
  const prev = gates.get(base) || { last: 0, tail: Promise.resolve() };
  const wait = Math.max(0, prev.last + minIntervalMs - Date.now());
  const run = prev.tail.then(async () => {
    await sleepMs(wait);
    gates.set(base, { last: Date.now(), tail: run });
    return fn();
  });
  gates.set(base, { last: prev.last, tail: run });
  try {
    return await run;
  } finally {
    // 链尾自愈：队列排空后清掉引用，防止长期驻留
    if (gates.get(base)?.tail === run) gates.set(base, { last: Date.now(), tail: Promise.resolve() });
  }
}

// ────────────────────────────── 响应剥壳 ──────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const OK_CODES = new Set(["0", "ok", "success", "no_error", "true"]);

function errorFields(payload, fallbackMessage) {
  let code = "";
  let message = fallbackMessage || "";
  if (isPlainObject(payload)) {
    const e = payload.error;
    if (typeof e === "string" && e) message = message || e;
    else if (isPlainObject(e)) {
      message = message || e.message || e.msg || e.error || "";
      code = code || e.code || e.type || "";
    }
    code = code || payload.code || payload.error_code || payload.err_code || payload.type || "";
    message = message || payload.message || payload.msg || payload.error_description || payload.detail || "";
    if (isPlainObject(payload.data)) {
      code = code || payload.data.code || "";
      message = message || payload.data.message || payload.data.msg || "";
    }
  }
  if (!message) message = payload == null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload).slice(0, MAX_MSG);
  return { code: String(code ?? ""), message: String(message ?? "") };
}

/** 明确「key 无效」才 expired；欠费/quota 类只保留 code。 */
function classifyAuthFailure({ status, code, message }) {
  const c = String(code || "").toLowerCase();
  const m = String(message || "").toLowerCase();
  const keyInvalid =
    c === "auth_api_key_invalid" ||
    c === "invalid_api_key" ||
    c === "api_key_invalid" ||
    c.includes("apikey_invalid") ||
    /invalid api key/.test(m) ||
    /api key (is )?(invalid|not found|expired|revoked|disabled)/.test(m) ||
    /key (is )?(invalid|not found)/.test(m);
  return keyInvalid ? "expired" : undefined;
}

/** 剥两种外壳：`{status:true,data}`（qnaigc）与直接对象（billing）；剥不出就带原文抛错。 */
function unwrap(json, endpoint, { expectObject } = {}) {
  if (json == null) {
    throw new UsageApiError(`${endpoint} 返回空响应体`, { status: 0, code: "empty_body" });
  }
  if (Array.isArray(json)) return json;
  if (!isPlainObject(json)) {
    if (expectObject) throw new UsageApiError(`${endpoint} 响应结构异常：${scrub(String(json))}`, { status: 0, code: "bad_shape" });
    return json;
  }
  if ("status" in json && (typeof json.status === "boolean" || json.status === "0" || json.status === "1")) {
    if (json.status === true || json.status === 1 || json.status === "1") {
      return "data" in json ? json.data : json;
    }
    const { code, message } = errorFields(json);
    const signIn = classifyAuthFailure({ code, message });
    throw new UsageApiError(`${endpoint} 业务失败：${scrub(message || code || "unknown")}`, {
      status: 0,
      code: code || "status_false",
      signIn,
      endpoint,
    });
  }
  if ("code" in json && !("data" in json)) {
    const c = String(json.code ?? "").toLowerCase();
    if (!OK_CODES.has(c) && c !== "" && typeof json.code === "string" && !/^(no_?error|success|ok)$/i.test(json.code)) {
      const { code, message } = errorFields(json);
      throw new UsageApiError(`${endpoint} 业务失败：${scrub(message || code)}`, {
        status: 0,
        code,
        signIn: classifyAuthFailure({ code, message }),
        endpoint,
      });
    }
  }
  if ("data" in json) return json.data;
  return json;
}

// ────────────────────────────── 请求内核 ──────────────────────────────

async function readBodyText(res) {
  if (!res) return "";
  if (typeof res.text === "function") return String(await res.text());
  if (typeof res.body === "string") return res.body;
  if (res.body != null && typeof res.body === "object") {
    try {
      return JSON.stringify(res.body);
    } catch {
      return "";
    }
  }
  return "";
}

function buildUrl(base, query) {
  const keys = Object.keys(query).filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== "");
  if (!keys.length) return base;
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, String(query[k]));
  return `${base}${base.includes("?") ? "&" : "?"}${usp.toString()}`;
}

/**
 * 统一请求：鉴权头选择 → fetch → 状态分档 → 剥壳。
 * 返回 `{ json, status, data }`（data 已剥壳）。
 */
async function callEndpoint({
  endpointName,
  url,
  method = "GET",
  account,
  signal,
  fetchImpl,
  sign,
  jsonBody,
  timeoutMs,
  throttle = true,
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
}) {
  const acct = readAccount(account);
  const body = jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
  const contentType = body === undefined ? "" : "application/json";
  const headers = await authHeaders({ acct, sign, method, url, contentType, body, endpoint: endpointName });
  const secrets = [acct.apiKey, acct.accessKey, acct.secretKey, headers.authorization].filter(Boolean);

  const impl = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof impl !== "function") {
    throw new UsageApiError(`${endpointName} 无可用 fetch 实现`, { status: 0, code: "no_fetch", endpoint: endpointName });
  }
  const base = url.slice(0, Math.max(url.indexOf("//") + 2, 0)) || "local";
  const doFetch = async () => {
    const init = { method, headers, signal: signal ?? undefined, redirect: "follow" };
    if (body !== undefined) init.body = body;
    let res;
    try {
      res = timeoutMs ? await impl(url, { ...init, signal: mergeSignal(signal, timeoutMs) }) : await impl(url, init);
    } catch (err) {
      if (err && (err.name === "AbortError" || /abort/i.test(String(err.message || "")))) {
        throw new UsageApiError(`${endpointName} 请求被取消`, { status: 0, code: "aborted", endpoint: endpointName, cause: err });
      }
      throw new UsageApiError(`${endpointName} 网络失败：${bury(scrub(err && err.message), secrets)}`, { status: 0, code: "network_error", endpoint: endpointName, cause: err });
    }
    return res;
  };

  const res = await gate(base, throttle !== false && fetchImpl == null, minIntervalMs, doFetch);
  const status = res && Number.isFinite(res.status) ? res.status : res ? 200 : 0;
  const text = await readBodyText(res);
  let json = null;
  let parseErr = null;
  if (text && text.trim()) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      parseErr = err;
    }
  }

  if (status < 200 || status >= 300) {
    const { code, message } = errorFields(json, parseErr ? text : "");
    const realCode = code || `http_${status}`;
    const signIn = classifyAuthFailure({ status, code: realCode, message });
    const err = new UsageApiError(`${endpointName} HTTP ${status}：${bury(scrub(message || realCode), secrets)}`, { status, code: realCode, signIn, endpoint: endpointName });
    if (res?.headers && typeof res.headers.get === "function") {
      const ra = res.headers.get("retry-after");
      if (ra && Number.isFinite(Number(ra))) err.retryAfterMs = Number(ra) * 1000;
    }
    throw err;
  }
  if (parseErr || json == null) {
    throw new UsageApiError(`${endpointName} 响应非 JSON（HTTP ${status}）：${bury(scrub(text), secrets)}`, { status, code: "bad_response", endpoint: endpointName });
  }
  try {
    const data = unwrap(json, endpointName);
    return { json, data, status };
  } catch (err) {
    if (err instanceof UsageApiError && err.message) err.message = bury(err.message, secrets);
    throw err;
  }
}

function mergeSignal(signal, timeoutMs) {
  const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  if (!timer) return signal;
  if (!signal) return timer;
  try {
    return AbortSignal.any ? AbortSignal.any([signal, timer]) : signal;
  } catch {
    return signal;
  }
}

// ────────────────────────────── 对外 fetch ──────────────────────────────

function pickSign(opts) {
  if (typeof opts?.sign === "function") return opts.sign;
  if (typeof opts?.deps?.sign === "function") return opts.deps.sign;
  return undefined;
}

/**
 * GET /v3/stat/usage —— 分模型 token 用量时间序列。
 * 内部夹紧跨度：day ≤31 天、hour ≤7 天；时间用带偏移的 RFC3399。
 */
export async function fetchUsageSeries({
  account,
  signal,
  fetchImpl,
  origin,
  granularity = "day",
  days = 7,
  timezone = DEFAULT_TIMEZONE,
  model,
  query,
  sign,
  now,
  timeoutMs,
  throttle,
} = {}) {
  const EP = usageEndpoints();
  const gran = pickEnum(granularity, ["day", "hour", "week", "month"], "day");
  const cap = GRANULARITY_MAX_DAYS[gran] ?? 31;
  const span = clampInt(days, 1, cap, 7);
  const ts = now instanceof Date ? now.getTime() : Number.isFinite(now) ? Number(now) : Date.now();
  const off = zoneOffsetMs(timezone, ts);
  const sod = startOfDayUtc(ts, off);
  const q = EP.query.usage;
  const params = {
    [q.from]: toIso(sod - (span - 1) * 86400_000, off, "00:00:00"),
    [q.to]: toIso(ts, off, "23:59:59"),
    [q.granularity]: gran,
    [q.timezone]: String(timezone || DEFAULT_TIMEZONE),
    ...(model ? { model: String(model) } : {}),
    ...(query && typeof query === "object" ? query : {}),
  };
  const url = buildUrl(resolveBase(origin, EP.inferOrigin, "/v3/stat/usage"), params);
  const { data } = await callEndpoint({
    endpointName: "stat/usage",
    url,
    account,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url, days: span, clampedDays: clampInt(days, 1, 1e9, 7) !== span, granularity: gran };
}

/** GET /v3/stat/usage/apikey/cost?type=day|week|month —— 当前 Key 的费用汇总。 */
export async function fetchApiKeyCost({ account, signal, fetchImpl, origin, type = "month", query, sign, timeoutMs, throttle } = {}) {
  const EP = usageEndpoints();
  const t = pickEnum(type, ["day", "week", "month"], "month");
  const url = buildUrl(resolveBase(origin, EP.inferOrigin, "/v3/stat/usage/apikey/cost"), {
    [EP.query.apiKeyCost.type]: t,
    ...(query && typeof query === "object" ? query : {}),
  });
  const { data } = await callEndpoint({
    endpointName: "stat/apikey/cost",
    url,
    account,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url, type: t };
}

/** GET /v3/stat/usage/cost-detail —— 费用明细（跨度自动夹紧到 grain 上限）。 */
export async function fetchCostDetail({
  account,
  signal,
  fetchImpl,
  origin,
  startDate,
  endDate,
  grain = "day",
  timezone = DEFAULT_TIMEZONE,
  query,
  sign,
  now,
  timeoutMs,
  throttle,
} = {}) {
  const EP = usageEndpoints();
  const g = pickEnum(grain, ["day", "hour", "month"], "day");
  const cap = GRANULARITY_MAX_DAYS[g] ?? 31;
  const ts = now instanceof Date ? now.getTime() : Number.isFinite(now) ? Number(now) : Date.now();
  const off = zoneOffsetMs(timezone, ts);
  const end = toDateKey(endDate ?? ts, off, ts);
  const start = toDateKey(startDate ?? endTsToStart(end, Math.min(7, cap)), off, ts);
  const range = clampRange(start, end, g === "hour" ? Math.min(cap, 7) : cap);
  const q = EP.query.costDetail;
  const url = buildUrl(resolveBase(origin, EP.inferOrigin, "/v3/stat/usage/cost-detail"), {
    [q.startDate]: range.start,
    [q.endDate]: range.end,
    [q.grain]: g,
    timezone: String(timezone || DEFAULT_TIMEZONE),
    ...(query && typeof query === "object" ? query : {}),
  });
  const { data } = await callEndpoint({
    endpointName: "stat/cost-detail",
    url,
    account,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url, startDate: range.start, endDate: range.end, grain: g, clamped: range.clamped };
}

function endTsToStart(endKey, span) {
  const t = Date.parse(`${endKey}T00:00:00Z`);
  return Number.isFinite(t) ? t - (span - 1) * 86400_000 : Date.now();
}

/** GET /v2/stat/export_log?size=1..500&page=N —— 逐请求日志。 */
export async function fetchExportLog({ account, signal, fetchImpl, origin, size = 100, page = 1, query, sign, timeoutMs, throttle } = {}) {
  const EP = usageEndpoints();
  const s = clampInt(size, 1, 500, 100);
  const p = clampInt(page, 1, 1_000_000, 1);
  const q = EP.query.exportLog;
  const url = buildUrl(resolveBase(origin, EP.inferOrigin, "/v2/stat/export_log"), {
    [q.size]: s,
    [q.page]: p,
    ...(query && typeof query === "object" ? query : {}),
  });
  const { data } = await callEndpoint({
    endpointName: "stat/export_log",
    url,
    account,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url, size: s, page: p };
}

/** GET /v1/apikey/quota/:api_key —— Key 限额。key 模式用 Bearer；aksk 模式走 sign。 */
export async function fetchKeyQuota({ account, signal, fetchImpl, origin, apiKey, sign, query, timeoutMs, throttle } = {}) {
  const EP = usageEndpoints();
  const acct = readAccount(account);
  const target = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : acct.apiKey;
  if (!target) {
    throw new UsageApiError("缺少要查询限额的 API Key", { status: 0, code: "api_key_required" });
  }
  const url = buildUrl(`${resolveBase(origin, EP.inferOrigin, "/v1/apikey/quota")}/${encodeURIComponent(target)}`, {
    ...(query && typeof query === "object" ? query : {}),
  });
  const { data } = await callEndpoint({
    endpointName: "apikey/quota",
    url,
    // aksk 模式下必须知道要查哪个 sk；查询用的 path 参数已带上。
    account: acct.mode === "aksk" ? acct : { ...acct, apiKey: target },
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url, apiKeyMasked: mask(target) };
}

/** GET billing-api/v1/account/balance-overview —— 余额总览（AK/SK 签名，必传 sign）。 */
export async function fetchBalanceOverview({ account, signal, fetchImpl, origin, sign, query, timeoutMs, throttle } = {}) {
  const EP = usageEndpoints();
  const url = buildUrl(resolveBase(origin, EP.billingOrigin, "/billing-api/v1/account/balance-overview"), {
    ...(query && typeof query === "object" ? query : {}),
  });
  const { data } = await callEndpoint({
    endpointName: "billing/balance-overview",
    url,
    account,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url };
}

/** GET billing-api/v1/respack/list —— 资源包列表（AK/SK 签名，必传 sign）。 */
export async function fetchRespackList({ account, signal, fetchImpl, origin, sign, query, timeoutMs, throttle } = {}) {
  const EP = usageEndpoints();
  const url = buildUrl(resolveBase(origin, EP.billingOrigin, "/billing-api/v1/respack/list"), {
    ...(query && typeof query === "object" ? query : {}),
  });
  const { data } = await callEndpoint({
    endpointName: "billing/respack/list",
    url,
    account,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    timeoutMs,
    throttle,
  });
  return { data, url };
}

/**
 * POST /v1/apikeys —— 用 AK/SK 签一个推理 Key。返回 `{ key, apiKeyMasked, data, url }`。
 * key 只在返回值里出现；错误/日志一律走 mask。
 */
export async function createInferenceKey({ account, name, signal, fetchImpl, origin, sign, body, query, timeoutMs, throttle } = {}) {
  const EP = usageEndpoints();
  const acct = readAccount(account);
  if (acct.mode !== "aksk") {
    throw new UsageApiError("签发推理 Key 需要 AK/SK 账号", { status: 0, code: "aksk_required" });
  }
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : "magpie-qiniu-lite";
  const jsonBody = { name: label, ...(body && typeof body === "object" ? body : {}) };
  const url = buildUrl(resolveBase(origin, EP.inferOrigin, "/v1/apikeys"), { ...(query && typeof query === "object" ? query : {}) });
  const { data } = await callEndpoint({
    endpointName: "apikeys/create",
    url,
    method: "POST",
    account: acct,
    signal,
    fetchImpl,
    sign: pickSign({ sign }),
    jsonBody,
    timeoutMs,
    throttle,
  });
  const found = deepFirstString(data, ["key", "api_key", "apikey", "secret", "token"]);
  if (!found) {
    throw new UsageApiError("签发 Key 成功但响应中缺少 key 字段", { status: 0, code: "key_missing" });
  }
  return { key: found, apiKeyMasked: mask(found), data, url };
}

function deepFirstString(node, keys, depth = 0) {
  if (depth > 4 || node == null) return "";
  if (Array.isArray(node)) {
    for (const it of node) {
      const v = deepFirstString(it, keys, depth + 1);
      if (v) return v;
    }
    return "";
  }
  if (!isPlainObject(node)) return "";
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const k of Object.keys(node)) {
    if (keys.includes(k)) continue;
    const v = node[k];
    if (v && typeof v === "object") {
      const found = deepFirstString(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

// ────────────────────────────── normalize* ──────────────────────────────

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(obj, keys) {
  if (!isPlainObject(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function rowsOf(node, depth = 0) {
  if (depth > 4) return [];
  if (Array.isArray(node)) return node.filter((x) => x != null);
  if (!isPlainObject(node)) return [];
  const listKeys = [
    "usage", "usages", "list", "items", "records", "data", "models", "result", "results", "rows", "details", "series",
  ];
  for (const k of listKeys) {
    const v = node[k];
    if (Array.isArray(v)) return v.filter((x) => x != null);
  }
  for (const v of Object.values(node)) {
    if (isPlainObject(v)) {
      const rows = rowsOf(v, depth + 1);
      if (rows.length) return rows;
    }
  }
  return [];
}

function unwrapForNormalize(json) {
  if (!isPlainObject(json)) return json;
  if (json.status === true && "data" in json) return json.data;
  if ("data" in json && json.data && typeof json.data === "object") return json.data;
  return json;
}

const BUCKET_KEYS = ["series", "buckets", "list", "items", "points", "detail", "details", "data", "usage", "records"];
const TIME_KEYS = ["time", "timestamp", "date", "day", "hour", "bucket", "stat_time", "created_at", "ts", "period"];
const INPUT_KEYS = ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "prompt", "input_usage", "usage_input", "in"];
const OUTPUT_KEYS = ["output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens", "completion", "output_usage", "usage_output", "out"];
const CACHED_KEYS = ["cached", "cached_tokens", "cachedTokens", "cache_read_tokens", "cache_read_input_tokens", "cacheReadTokens", "cache_tokens", "cached_usage"];
const POINTS_KEYS = ["points", "total_points", "used_points", "consume_points", "consumed_points", "credit", "credits", "fee", "cost", "amount"];
const MODEL_KEYS = ["model", "model_name", "modelName", "model_id", "modelId", "name", "id"];

function bucketTime(b) {
  const raw = firstDefined(b, TIME_KEYS);
  if (raw == null) return "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e11 ? raw : raw * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : String(raw);
  }
  return String(raw);
}

/**
 * → [{ model, input, output, cached, points, buckets:[{time,input,output}] }]
 * 容忍：缺 categories / 缺 buckets / 字段别名 / `{status,data}` 外壳 / 空数组。
 */
export function normalizeUsageSeries(json) {
  const root = unwrapForNormalize(json);
  const rows = rowsOf(root);
  const out = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const model = String(firstDefined(row, MODEL_KEYS) ?? "").trim();
    let bucketNode = undefined;
    for (const k of BUCKET_KEYS) {
      if (Array.isArray(row[k])) {
        bucketNode = row[k];
        break;
      }
    }
    const buckets = Array.isArray(bucketNode)
      ? bucketNode
          .filter((b) => b != null)
          .map((b) =>
            isPlainObject(b)
              ? { time: bucketTime(b), input: num(firstDefined(b, INPUT_KEYS)), output: num(firstDefined(b, OUTPUT_KEYS)) }
              : { time: "", input: 0, output: 0 },
          )
      : [];
    const input = num(firstDefined(row, INPUT_KEYS)) || buckets.reduce((a, b) => a + (b.input || 0), 0);
    const output = num(firstDefined(row, OUTPUT_KEYS)) || buckets.reduce((a, b) => a + (b.output || 0), 0);
    const cached = num(firstDefined(row, CACHED_KEYS));
    const points = num(firstDefined(row, POINTS_KEYS));
    if (!model && !input && !output && !points && !buckets.length) continue;
    out.push({ model: model || "unknown", input, output, cached, points, buckets });
  }
  return out;
}

const FEE_KEYS = ["fee", "total_fee", "totalFee", "amount", "cost", "total_cost", "money", "price"];
const NAME_KEYS = ["name", "model", "model_name", "title", "label", "id"];
const UNIT_KEYS = ["unit", "units", "price_unit", "billing_unit"];
const USAGE_KEYS = ["usage", "used", "quantity", "count", "num", "amount_used", "consume"];

/** → { totalFee, currency, models:[{name, fee, items:[{name,unit,usage,fee}]}] } */
export function normalizeCost(json) {
  const root = unwrapForNormalize(json);
  const currency = String(firstDefined(root, ["currency", "currency_code", "money_type", "coin"]) ?? "CNY");
  const rows = rowsOf(root);
  const models = [];
  const declared = firstDefined(root, FEE_KEYS);
  let totalFee = declared === undefined ? null : num(declared);
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const name = String(firstDefined(row, NAME_KEYS) ?? "").trim() || "unknown";
    let fee = num(firstDefined(row, FEE_KEYS));
    const itemNode = Array.isArray(row.items) ? row.items : Array.isArray(row.details) ? row.details : Array.isArray(row.sub_items) ? row.sub_items : [];
    const items = itemNode
      .filter((it) => isPlainObject(it))
      .map((it) => ({
        name: String(firstDefined(it, NAME_KEYS) ?? "").trim() || "unknown",
        unit: String(firstDefined(it, UNIT_KEYS) ?? ""),
        usage: num(firstDefined(it, USAGE_KEYS)),
        fee: num(firstDefined(it, FEE_KEYS)),
      }));
    if (!fee) {
      const summed = items.reduce((a, it) => a + (it.fee || 0), 0);
      if (summed) fee = summed;
    }
    models.push({ name, fee, items });
  }
  if (totalFee === null || !Number.isFinite(totalFee)) {
    totalFee = models.reduce((a, m) => a + (m.fee || 0), 0);
  }
  return { totalFee: round4(totalFee), currency, models };
}

function round4(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function toYuan(v) {
  const n = numOrNull(v);
  if (n === null) return null;
  return round4(n / BALANCE_UNIT);
}

/**
 * → { available, cash, present, creditLine, unpaid, currency, email, accountId }
 * 单位结论：上游以「元 × 1e8」计（CONTRACT §1），这里除回元。
 */
export function normalizeBalance(json) {
  const root = unwrapForNormalize(json);
  const src = isPlainObject(root) ? root : {};
  const account = isPlainObject(src.account) ? src.account : isPlainObject(src.account_info) ? src.account_info : {};
  const pick = (keys) => firstDefined(src, keys) ?? firstDefined(account, keys) ?? firstDefined(src.balance_overview, keys);
  return {
    available: toYuan(pick(["available_balance", "availableBalance", "available", "usable_balance", "balance"])),
    cash: toYuan(pick(["cash_balance", "cashBalance", "cash"])),
    present: toYuan(pick(["present_balance", "presentBalance", "present", "gift_balance", "bonus_balance"])),
    creditLine: toYuan(pick(["credit_line", "creditLine", "credit", "credit_limit", "quota"])),
    unpaid: toYuan(pick(["unpaid_balance", "unpaidBalance", "unpaid", "owe_balance", "arrears"])),
    currency: String(firstDefined(src, ["currency", "currency_code", "money_type"]) ?? firstDefined(account, ["currency"]) ?? "CNY"),
    email: String(firstDefined(src, ["email", "mail"]) ?? firstDefined(account, ["email", "mail"]) ?? ""),
    accountId: String(firstDefined(src, ["account_id", "accountId", "uid", "user_id"]) ?? firstDefined(account, ["account_id", "uid"]) ?? ""),
  };
}

// 显式声明：本模块没有任何签到相关导出（CONTRACT §0）。
export const USAGE_API_VERSION = "1.0.0";
