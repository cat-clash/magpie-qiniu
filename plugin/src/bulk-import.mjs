// src/bulk-import.mjs — 批量导入：把多行文本解析成凭据条目，并做受控并发。
//
// 支持的形态（每行一条，`#` 开头或空行忽略；行内逗号/空白/制表/`=` 都算分隔）：
//   sk-xxxx                              → { apiKey }
//   备注, sk-xxxx                         → { label, apiKey }
//   sk-xxxx, 备注                         → { apiKey, label }（自动判断哪个像 Key）
//   AK:SK                                → { accessKey, secretKey }
//   AK, SK                               → { accessKey, secretKey }
//   AK:SK, 备注                           → { accessKey, secretKey, label }
//   也接受整段 JSON：[{"key":"sk-…","label":"x"}] / {"apiKey":"sk-…"} / {"accessKey":"…","secretKey":"…"}
//
// 设计取向：**只做语法校验，不做网络校验**（谁能用是登录阶段的事）。
// 解析错误不抛，逐行回传原因，界面上一行一条 —— 用户最烦的是「导入失败」四个字。

import { PROVIDER_ID_RE } from "./config.mjs";
import { keyFingerprint } from "./cache-key.mjs";

const KEY_RE = /^(sk|tk)-[A-Za-z0-9_\-]{8,}$/;
const AK_RE = /^[A-Za-z0-9_\-]{16,64}$/;

function cleanLabel(v) {
  const s = typeof v === "string" ? v.trim().replace(/^["']|["']$/g, "") : "";
  return s.length > 40 ? s.slice(0, 40) : s;
}

function looksKey(v) {
  return typeof v === "string" && KEY_RE.test(v.trim());
}

/** 逐字段判定 AK/SK 对：两个都像凭据、都不是 sk-/tk- Key、且互不相等。 */
function looksAkskPair(a, b) {
  if (!a || !b) return false;
  const x = a.trim();
  const y = b.trim();
  if (looksKey(x) || looksKey(y)) return false;
  return AK_RE.test(x) && AK_RE.test(y) && x !== y;
}

function splitFields(line) {
  return line
    .split(/[\s,;=\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonBlob(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.keys) ? data.keys : [data];
  return list;
}

function entryFromObject(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  const label = cleanLabel(obj.label ?? obj.name ?? obj.remark ?? obj.note ?? "");
  const apiKey = typeof obj.key === "string" ? obj.key.trim() : typeof obj.apiKey === "string" ? obj.apiKey.trim() : "";
  if (looksKey(apiKey)) return label ? { apiKey, label } : { apiKey };
  const accessKey = typeof obj.accessKey === "string" ? obj.accessKey.trim() : typeof obj.ak === "string" ? obj.ak.trim() : "";
  const secretKey = typeof obj.secretKey === "string" ? obj.secretKey.trim() : typeof obj.sk === "string" ? obj.sk.trim() : "";
  if (accessKey && secretKey) return label ? { accessKey, secretKey, label } : { accessKey, secretKey };
  return undefined;
}

/**
 * @param {string} text 多行凭据文本
 * @param {{max?:number}} [options]
 * @returns {{entries:Array<{apiKey?:string,accessKey?:string,secretKey?:string,label?:string}>, errors:Array<{line:number,reason:string,preview:string}>}}
 */
export function parseCredentialBlob(text, options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.trunc(options.max) : 200;
  const entries = [];
  const errors = [];
  if (typeof text !== "string" || !text.trim()) {
    return { entries, errors: [{ line: 0, reason: "内容是空的", preview: "" }] };
  }

  const jsonList = parseJsonBlob(text);
  if (jsonList) {
    jsonList.forEach((obj, i) => {
      const entry = entryFromObject(obj);
      if (entry) entries.push(entry);
      else errors.push({ line: i + 1, reason: "JSON 里这条既没有 sk-/tk- Key，也没有成对的 AK/SK", preview: JSON.stringify(obj).slice(0, 60) });
    });
    return finish(entries, errors, max);
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const fields = splitFields(line);
    if (!fields.length) return;

    // 1) AK:SK 这种冒号连写（冒号不是分隔符，单独看）
    if (fields.length === 1 && line.includes(":")) {
      const [ak, sk, ...rest] = line.split(":");
      if (looksAkskPair(ak, sk)) {
        const label = cleanLabel(rest.join(":"));
        entries.push(label ? { accessKey: ak.trim(), secretKey: sk.trim(), label } : { accessKey: ak.trim(), secretKey: sk.trim() });
        return;
      }
    }
    // 2) 单字段：必须是 sk-/tk- Key
    if (fields.length === 1) {
      if (looksKey(fields[0])) {
        entries.push({ apiKey: fields[0] });
        return;
      }
      errors.push({ line: lineNo, reason: "看不出是 sk-/tk- Key，也不是 AK:SK", preview: line.slice(0, 40) });
      return;
    }
    // 3) 两字段：Key + 备注，或 AK + SK
    if (looksKey(fields[0]) || looksKey(fields[1])) {
      const key = looksKey(fields[0]) ? fields[0] : fields[1];
      const other = looksKey(fields[0]) ? fields[1] : fields[0];
      const label = cleanLabel(other);
      entries.push(label ? { apiKey: key, label } : { apiKey: key });
      return;
    }
    if (looksAkskPair(fields[0], fields[1])) {
      const label = cleanLabel(fields.slice(2).join(" "));
      entries.push(label ? { accessKey: fields[0], secretKey: fields[1], label } : { accessKey: fields[0], secretKey: fields[1] });
      return;
    }
    // 4) 三字段：AK SK 备注
    if (fields.length >= 3 && looksAkskPair(fields[0], fields[1])) {
      const label = cleanLabel(fields.slice(2).join(" "));
      entries.push(label ? { accessKey: fields[0], secretKey: fields[1], label } : { accessKey: fields[0], secretKey: fields[1] });
      return;
    }
    errors.push({ line: lineNo, reason: "这一行既没有 sk-/tk- Key，也没有成对的 AK/SK", preview: line.slice(0, 40) });
  });
  return finish(entries, errors, max);
}

function finish(entries, errors, max) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const fp = keyFingerprint(entry.apiKey || `${entry.accessKey}:${entry.secretKey}`);
    if (seen.has(fp)) continue;
    seen.add(fp);
    if (unique.length >= max) {
      errors.push({ line: 0, reason: `超过单次导入上限 ${max} 条，多余的已忽略`, preview: "" });
      break;
    }
    unique.push(entry);
  }
  return { entries: unique, errors };
}

/** 受控并发：结果顺序与输入一致；单个失败不影响其它。 */
export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 4, list.length || 1));
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** 账号去重键：同一把 Key（或同一对 AK/SK）只能有一个账号。 */
export function dedupeKeyOf(auth) {
  if (!auth || typeof auth !== "object") return "";
  const apiKey = typeof auth.apiKey === "string" ? auth.apiKey : typeof auth.key === "string" ? auth.key : "";
  const aksk = auth.accessKey && auth.secretKey ? `${auth.accessKey}:${auth.secretKey}` : "";
  return keyFingerprint(apiKey || aksk);
}

export function isValidProviderId(value) {
  return typeof value === "string" && PROVIDER_ID_RE.test(value);
}
