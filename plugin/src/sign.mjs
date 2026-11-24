// plugin/src/sign.mjs
// 七牛云 AK/SK（`Authorization: Qiniu <AK>:<EncodedSign>`）签名模块。
// 规则逐字依据（见 research/sign-spec.md）：
//   - https://developer.qiniu.com/kodo/1201/access-token         （管理凭证 / Qiniu 签名算法 + 官方黄金样例）
//   - https://developer.qiniu.com/aitokenapi/13405/set-api-key-limit-api  （AK/SK 签名算法，api.qnaigc.com）
//   - https://developer.qiniu.com/aitokenapi/13382/new-usage-api  （/v3/stat/usage 的 query 样例，含 %2B 编码）
// 零运行时依赖：只用 node:crypto。禁止在本模块打印 AK/SK/签名。

import { createHmac } from "node:crypto";

/** 官方 JS 参考实现里 body 被丢弃的 Content-Type 前缀（CONTRACT §3 要求的两条 + 文档里的 octet-stream） */
const NO_BODY_CT_PREFIXES = ["application/x-www-form-urlencoded", "multipart/form-data"];
const OCTET_STREAM_CT = "application/octet-stream";

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const SPACE_OR_CTRL = /[\s\x00-\x1f\x7f]/;

/** URL 安全 Base64：`+`→`-`，`/`→`_`，保留 `=` 填充（与官方文档参考实现一致）。 */
export function urlSafeBase64Encode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** `x-qiniu-date` / `X-QINIU-DATE` → `X-Qiniu-Date`（首字母与 `-` 后字母大写，其余小写）。 */
export function canonicalXQiniuKey(key) {
  return String(key)
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");
}

/** X-Qiniu-Date 建议值：RFC3339 UTC 秒级（官方签名凭证有效期 15 分钟）。返回值可安全入日志。 */
export function nowXQiniuDate(now = new Date()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 把 URL 拆成签名需要的 host / path / query，**不做任何百分号编码改写**。
 * 支持绝对 URL、协议相对 URL、纯 path（此时必须显式传 host）。
 * 丢弃 `#fragment`（不上线）；剥离 userinfo；空 path → `/`。
 */
export function splitUrl(url) {
  let s = String(url ?? "").trim();
  if (!s) throw new TypeError("sign: url 不能为空");
  let host = "";
  let rest = s;
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)?\/\/([^/?#]*)([\s\S]*)$/.exec(s);
  if (m) {
    const authority = m[2];
    host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
    rest = m[3];
  } else {
    const proto = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)\/\//.exec(s);
    if (proto) throw new TypeError("sign: url 缺少主机名");
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf("?");
  const path = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q + 1) : "";
  return { host, path: path || "/", query };
}

/** 接受普通对象 / Map / Headers 三种头集合，产出 [小写key, 原始key, 值] 列表。 */
function headerTuples(headers) {
  const out = [];
  if (!headers) return out;
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    headers.forEach((value, key) => out.push([String(key).toLowerCase(), String(key), value]));
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out.push([String(key).toLowerCase(), String(key), value]);
  }
  return out;
}

/** 多值头取第一个（对齐 Go `http.Header.Get`）。 */
function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** 非字符串 body 归一：bytes→utf8 文本，对象→JSON。调用方仍应传实际上线的字符串。 */
function bodyToString(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder("utf-8").decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(new Uint8Array(body));
  if (typeof body === "object") return JSON.stringify(body);
  return String(body);
}

/**
 * 生成待签名字符串。默认输出 = 官方口径（query 挂在请求行 Path 后面）。
 *
 * @param {object}  o
 * @param {string}  o.method            HTTP 方法（大写化后参与签名）
 * @param {string}  o.url               完整 URL 或 path；query 按**上线原样**（已编码）参与签名
 * @param {string}  [o.contentType]     显式 Content-Type；为空时回退读 headers
 * @param {string}  [o.body]            请求体原文
 * @param {object}  [o.headers]         只取 `X-Qiniu-*` 参与签名
 * @param {string}  [o.accessKey]       保留位：Qiniu 签名串本身不含 AK（契约固定签名，勿删）
 * @param {string}  [o.host]            覆盖 Host 行（传纯 path 时必填）
 * @param {"path"|"line"} [o.queryMode] query 位置：默认 `path`（官方）；`line` 为独立 query 行（排查用）
 * @param {"request-line"|"split-lines"} [o.style] 默认 `request-line`（官方 `METHOD /p?q`）；`split-lines` 拆成 Method / Path 两行
 * @returns {string} 待签名字符串
 */
export function signingString(o = {}) {
  const {
    method = "GET",
    url,
    body = "",
    headers = {},
    host,
    queryMode = "path",
    style = "request-line",
  } = o;
  // accessKey 为契约保留位，Qiniu 签名串不含 AK
  void o.accessKey;

  if (style !== "request-line" && style !== "split-lines") {
    throw new TypeError(`sign: 未知 style "${style}"`);
  }
  if (queryMode !== "path" && queryMode !== "line") {
    throw new TypeError(`sign: 未知 queryMode "${queryMode}"`);
  }

  const parsed = splitUrl(url);
  const hostLine = host || parsed.host;
  if (!hostLine) throw new TypeError("sign: 无法确定 Host（url 无主机名且未传 host）");
  const path = parsed.path.startsWith("/") ? parsed.path : "/" + parsed.path;
  const query = parsed.query;
  const tuples = headerTuples(headers);

  let ct = o.contentType === undefined || o.contentType === null ? "" : String(o.contentType);
  if (!ct) {
    const found = tuples.find(([lower]) => lower === "content-type");
    if (found) ct = String(firstValue(found[2]) ?? "");
  }

  const rawBody = bodyToString(body);
  const ctLower = ct.toLowerCase();
  // 规则：octet-stream / form-urlencoded / multipart 不附 body；Content-Type 为空时官方实现也不附 body
  const omitBody =
    ctLower === OCTET_STREAM_CT || NO_BODY_CT_PREFIXES.some((p) => ctLower.startsWith(p));
  const signedBody = ct && !omitBody ? rawBody : "";

  const lines = [];
  const upMethod = String(method || "GET").toUpperCase();
  if (style === "request-line") {
    let head = `${upMethod} ${path}`;
    if (query && queryMode === "path") head += `?${query}`;
    lines.push(head);
    if (query && queryMode === "line") lines.push(query);
    lines.push(`Host: ${hostLine}`);
  } else {
    lines.push(upMethod);
    lines.push(path);
    if (query) lines.push(query);
    lines.push(hostLine);
  }

  if (ct) lines.push(`Content-Type: ${ct}`);

  const xq = [];
  for (const [lower, original, value] of tuples) {
    if (!lower.startsWith("x-qiniu-")) continue;
    if (lower === "x-qiniu-") continue; // key 不可为空字符
    const formatted = canonicalXQiniuKey(original);
    xq.push([formatted, String(firstValue(value) ?? "")]);
  }
  xq.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // 格式化后 key 的 ASCII 升序
  for (const [k, v] of xq) lines.push(`${k}: ${v}`);

  return `${lines.join("\n")}\n\n${signedBody}`;
}

/**
 * 生成完整 Authorization 头值：`Qiniu <AK>:<EncodedSign>`。
 * 参数同 signingString，另需 secretKey。
 */
export function qiniuAuthHeader(o = {}) {
  const { accessKey, secretKey } = o;
  const ak = typeof accessKey === "string" ? accessKey.trim() : "";
  const sk = typeof secretKey === "string" ? secretKey.trim() : "";
  if (!ak) throw new TypeError("sign: accessKey 不能为空");
  if (!sk) throw new TypeError("sign: secretKey 不能为空");
  const ss = signingString(o);
  const sign = createHmac("sha1", sk).update(ss, "utf8").digest();
  return `Qiniu ${ak}:${urlSafeBase64Encode(sign)}`;
}

/**
 * 解析用户粘贴的 AK/SK。支持 `AK:SK`、`AK,SK`、`AK SK`，并容忍粘贴整条 `Qiniu AK:SK`。
 * 错误信息只给 code，**绝不回显输入内容**（CONTRACT §0：不打印 secret）。
 * @returns {{ok:boolean, accessKey?:string, secretKey?:string, error?:string}}
 */
export function splitAksk(value) {
  if (typeof value !== "string") return { ok: false, error: "not_string" };
  let s = value;
  s = s.replace(/^[\s'"`\uFEFF]+|[\s'"`\uFEFF]+$/g, "");
  s = s.replace(/^qiniu\s*[:=]?\s+/i, "");
  s = s.replace(/^[\s'"`]+|[\s'"`]+$/g, "");
  if (!s) return { ok: false, error: "empty" };

  const looksApiKey = (x) => /^(sk-|tk-)/i.test(x);
  let ak = "";
  let sk = "";
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length !== 2) return { ok: false, error: "too_many_colons" };
    [ak, sk] = parts;
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length !== 2) return { ok: false, error: "too_many_commas" };
    [ak, sk] = parts;
  } else if (/\s/.test(s)) {
    const parts = s.trim().split(/\s+/);
    if (parts.length !== 2) return { ok: false, error: "too_many_fields" };
    [ak, sk] = parts;
  } else if (looksApiKey(s)) {
    return { ok: false, error: "api_key_not_aksk" };
  } else {
    return { ok: false, error: "no_separator" };
  }

  ak = ak.trim();
  sk = sk.trim();
  if (!ak || !sk) return { ok: false, error: "missing_part" };
  if (SPACE_OR_CTRL.test(ak) || SPACE_OR_CTRL.test(sk)) return { ok: false, error: "space_in_part" };
  if (!PRINTABLE_ASCII.test(ak) || !PRINTABLE_ASCII.test(sk)) return { ok: false, error: "bad_chars" };
  if (ak.length < 4 || sk.length < 4) return { ok: false, error: "too_short" };
  if (looksApiKey(ak) || looksApiKey(sk)) return { ok: false, error: "api_key_not_aksk" };
  return { ok: true, accessKey: ak, secretKey: sk };
}
