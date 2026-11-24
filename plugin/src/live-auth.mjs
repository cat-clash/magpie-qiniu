// src/live-auth.mjs — 账号运行时状态（模块级、按账号隔离）。
//
// 为什么不把状态挂在插件闭包的局部变量上：magpie 同一个插件可能同时服务多个账号，
// 闭包变量会串号；而 magpie 也没有「回写账号存储」以外的手段让我们读回全部账号。
// 这里的 Map 只存**运行时快照**（最新一次 getAuth 看到的凭据 + 宿主 getAuth 句柄 + 用量缓存），
// 不是账号真源 —— 真源永远是宿主的 getAuth()。
//
// 单测要点：remember / latestOf / forget / liveAuthCount / hostGetterCount 都是纯函数式操作，
// 不含网络、不含定时器。

const live = new Map(); // accountKey -> { auth, getAuth, usageCache, costCache, samples, requestLog }

/** 账号键：优先 id，其次 uid，再次 Key 指纹；都没有就返回空串（调用方自己兜底）。 */
export function accountKey(auth) {
  if (!auth || typeof auth !== "object") return "";
  const id = typeof auth.id === "string" ? auth.id.trim() : "";
  if (id) return id;
  const uid = typeof auth.uid === "string" ? auth.uid.trim() : "";
  if (uid) return uid;
  const key = typeof auth.key === "string" ? auth.key : typeof auth.apiKey === "string" ? auth.apiKey : "";
  return key ? `k:${key.slice(-12)}` : "";
}

function slot(auth) {
  const k = accountKey(auth);
  if (!k) return undefined;
  let s = live.get(k);
  if (!s) {
    s = { auth: undefined, getAuth: undefined, usageCache: undefined, costCache: undefined, samples: [], requestLog: [] };
    live.set(k, s);
  }
  return s;
}

/** 记住最新一次看到的凭据快照（合并，旧的字段不会因为新快照缺字段而丢）。 */
export function remember(auth) {
  if (!auth || typeof auth !== "object") return undefined;
  const s = slot(auth);
  if (!s) return undefined;
  s.auth = { ...(s.auth || {}), ...auth };
  return s.auth;
}

/** 取该账号的最新快照；没记过就返回传入值。 */
export function latestOf(auth) {
  const s = slot(auth);
  return (s && s.auth) || auth;
}

/** 局部补丁：给快照打补丁并返回新对象（不写宿主存储，只改内存视图）。 */
export function patchAuth(auth, patch) {
  const s = slot(auth);
  const base = { ...latestOf(auth), ...(patch || {}) };
  if (s) s.auth = base;
  return base;
}

export function setHostGetter(auth, getAuth) {
  const s = slot(auth);
  if (s && typeof getAuth === "function") s.getAuth = getAuth;
}

export function hostGetterOf(auth) {
  const s = slot(auth);
  return s && s.getAuth;
}

export function setUsageCache(auth, value, at = Date.now()) {
  const s = slot(auth);
  if (s) s.usageCache = { value, at };
}

export function usageCacheOf(auth) {
  const s = slot(auth);
  return s && s.usageCache;
}

export function setCostSample(auth, sample) {
  const s = slot(auth);
  if (!s || !sample) return;
  s.samples.push({ at: Date.now(), total: sample.total ?? null, day: sample.day ?? null, models: sample.models ?? null });
  while (s.samples.length > 12) s.samples.shift();
  s.costCache = { value: sample, at: Date.now() };
}

export function costStats(auth) {
  const s = slot(auth);
  if (!s || !s.samples.length) return undefined;
  const rows = s.samples.filter((x) => Number.isFinite(x.total) || Number.isFinite(x.day));
  if (!rows.length) return undefined;
  const last = rows[rows.length - 1];
  return {
    at: last.at,
    day: Number.isFinite(last.day) ? last.day : undefined,
    total: Number.isFinite(last.total) ? last.total : undefined,
    unconfirmed: true,
    note: "来自费用接口取样，存在 5–15 分钟延迟",
  };
}

/** 记一条请求元信息，供诊断与排错（不含正文，最多 REQUEST_LOG_CAP 条）。 */
export function pushRequest(auth, entry, cap = 24) {
  const s = slot(auth);
  if (!s) return;
  s.requestLog.push({ at: Date.now(), ...entry });
  while (s.requestLog.length > cap) s.requestLog.shift();
}

export function requestLogOf(auth) {
  const s = slot(auth);
  return s ? s.requestLog.slice() : [];
}

/** 最近一次实际发出去的 Key（loader 的 apiKey 字段与诊断用）。 */
export function currentAuth(auth) {
  const s = slot(auth);
  return (s && s.auth) || auth;
}

export function forget(auth) {
  const k = accountKey(auth);
  if (k) live.delete(k);
  return k;
}

export function resetLiveAuth() {
  live.clear();
}

export function liveAuthCount() {
  return live.size;
}

export function hostGetterCount() {
  let n = 0;
  for (const s of live.values()) if (typeof s.getAuth === "function") n += 1;
  return n;
}

export function liveKeys() {
  return [...live.keys()];
}
