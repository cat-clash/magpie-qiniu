// src/health.mjs — 进程内模型健康快照：记下每个模型最近的成功/失败，连续失败到阈值就标 dead，
// provider.models 钩子据此把 status 改成 "deprecated"，宿主就不会再把请求路由给它。
//
// 为什么需要它（七牛实测，见 docs/troubleshooting.md）：91 个模型里有一批对本账号是「确定
// 不可用」——未标价的上游回 503（插件改判 404 model_not_priced），不在模型组的上游回 403
// （改判 404 model_out_of_scope）。现在只能撞了才知道：每次白等一个 RTT，还要把错误抛给用户。
// 把「撞过的结论」记下来，下一轮目录就能提前躲开，选模型时也不再撞雷。
//
// 为什么默认只在内存（不落盘）：结论有时效 —— 账号加钱、开白名单、上游补价之后模型就好了。一份
// 过期的状态文件会让插件永久拒绝一个其实可用的模型，代价远大于重新撞一次；进程随宿主重启，
// 内存态自然遗忘，等于自带「定期重新求证」。
//
// 可选持久化（默认关，零 IO）：给 stateFile 一个路径，就把结论落盘到那里，宿主重启后还认得上次
// 判死的模型；不给（默认空串）则完全维持纯内存行为，**一个 fs 调用都不发生**。落盘的只是
// failures / deadAtMs / lastStatus / lastCode，`dead` 是派生值（deadAtMs > 0）不落盘，避免两处
// 真值打架。落盘文件只是「快照缓存」不是权威：读到坏 JSON、时钟偏移、TTL 已过，一律当没读过。
//
// 语义：ok=true 清零（dead 一并清除，视为恢复）；ok=false 计数 +1，达到 failureThreshold 才
// dead；dead 之后 ttlMs 内 isDead() 为 true，过期则按「半信半疑」返回 false 并把这条记录丢掉
// （下次失败从 1 重新数）。调用方只该在 404/503/400 这类「确定不可用」上记失败 —— 限流、欠费
// 是账号级问题，归 breaker.mjs 管，记到这里会把好模型一起标死。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_MODELS = 500;

/** 落盘格式版本；将来改形状就 +1，读到别的版本按空状态处理。 */
const STATE_VERSION = 1;
/** 落盘文件名（放在集成方给的 stateDir 下）。 */
export const HEALTH_STATE_FILE = "model-health.json";
/** 允许的时钟偏移：文件里的 savedAt 比当前时刻领先超过这个数，整份忽略（换机/改表时间）。 */
const CLOCK_SKEW_MS = 5 * 60_000;

/** 默认参数（只读，供集成方与诊断输出引用）。 */
export const HEALTH_DEFAULTS = Object.freeze({
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  ttlMs: DEFAULT_TTL_MS,
  maxModels: DEFAULT_MAX_MODELS,
});

const EMPTY_STATE = () => ({ failures: 0, dead: false, sinceMs: 0, lastStatus: 0, lastCode: "" });

/**
 * 拼「健康态文件」的路径：`healthStatePath("/x/state")` → `/x/state/model-health.json`。
 * 纯字符串拼接（走 node:path 的 join，两个平台都对），不碰 fs，也不做存在性检查。
 *
 * @param {string} dir 目录（通常是插件的 stateDir）
 * @param {string} [name="model-health.json"] 文件名
 * @returns {string} 拼好的路径；dir 不是字符串/为空时返回空串（调用方据此当「不持久化」）
 */
export function healthStatePath(dir, name = HEALTH_STATE_FILE) {
  if (typeof dir !== "string" || !dir.trim()) return "";
  const base = dir.trim();
  const fileName = typeof name === "string" && name.trim() ? name.trim() : HEALTH_STATE_FILE;
  return join(base, fileName);
}

let realFs = null;
/** 惰性拿真 fs：只有真的要读写文件时才 require，默认路径连模块都不加载。 */
function builtinFs() {
  if (!realFs) realFs = createRequire(import.meta.url)("node:fs");
  return realFs;
}

/**
 * 建一个模型健康仓库。默认纯内存；给了 stateFile 才落盘。
 *
 * @param {object} [init]
 * @param {number} [init.failureThreshold=3] 连续失败多少次判 dead（最小 1）
 * @param {number} [init.ttlMs=1800000]      dead 状态的冷却时长，过期即重新求证
 * @param {number} [init.maxModels=500]      最多记多少个模型，超出按 LRU 淘汰
 * @param {() => number} [init.now=Date.now] 可注入时钟（测试不要用真实时间）
 * @param {string} [init.stateFile=""]       健康态文件路径；空串 = 纯内存，绝不做任何 IO
 * @param {{readFileSync:Function, writeFileSync:Function, mkdirSync:Function}} [init.fs]
 *        注入 fs 实现（测试用假 fs）；只在 stateFile 非空时才会被碰，默认惰性 require("node:fs")
 */
export function createHealthStore({
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  ttlMs = DEFAULT_TTL_MS,
  maxModels = DEFAULT_MAX_MODELS,
  now = Date.now,
  stateFile = "",
  fs = undefined,
} = {}) {
  const threshold = Math.max(1, Math.trunc(Number(failureThreshold) || 0));
  const ttl = Math.max(0, Math.trunc(Number(ttlMs) || 0));
  const cap = Math.max(1, Math.trunc(Number(maxModels) || 0));

  // 持久化开关：只有 stateFile 是非空字符串时才打开。关着的时候 fsImpl 是 null，
  // 任何读写路径都在最前面短路 —— 连注入的假 fs 都不会被调用一次。
  const file = typeof stateFile === "string" ? stateFile.trim() : "";
  const persist = file.length > 0;
  const fsImpl = !persist
    ? null
    : fs && typeof fs === "object"
      ? fs
      : builtinFs();

  // Map 的插入顺序就是 LRU 顺序：命中时先 delete 再 set，把这条推到队尾。
  /** @type {Map<string, {failures:number, deadAtMs:number, lastStatus:number, lastCode:string}>} */
  const entries = new Map();

  /** 上次成功落盘的内容指纹（不含 savedAt），用来判断「状态是不是真的变了」。 */
  let savedSignature = null;

  /** 只接受非空字符串；空串 / null / 数字 / 对象一律当没传。 */
  function keyOf(modelId) {
    if (typeof modelId !== "string") return "";
    return modelId.trim();
  }

  function fresh() {
    return { failures: 0, deadAtMs: 0, lastStatus: 0, lastCode: "" };
  }

  function expired(e, t) {
    return e.deadAtMs > 0 && t - e.deadAtMs >= ttl;
  }

  function trim() {
    while (entries.size > cap) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /** 落盘形状：id 排序（与 LRU 顺序无关），`dead` 不出现。 */
  function persistedEntries() {
    const ids = [...entries.keys()].sort();
    const out = {};
    for (const k of ids) {
      const e = entries.get(k);
      out[k] = {
        failures: e.failures,
        deadAtMs: e.deadAtMs,
        lastStatus: e.lastStatus,
        lastCode: e.lastCode,
      };
    }
    return out;
  }

  /**
   * 构造时读一次：不存在 / 坏 JSON / 形状不对 / savedAt 领先太多 → 全部静默当空状态。
   * 读进来的条目照现有 TTL 逻辑例行清理一次（不装定时器，不额外写盘）。
   */
  function loadFromDisk() {
    if (!persist) return;
    let text;
    try {
      text = fsImpl.readFileSync(file, "utf8");
    } catch {
      return; // 文件不存在 / 无权限：当空状态
    }
    let parsed;
    try {
      const body = typeof text === "string" ? text : String(text);
      // 被 Windows 编辑器存成 UTF-8 with BOM 的文件也要认（手工改过状态的场景）。
      parsed = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
    } catch {
      return; // 坏 JSON：当空状态
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (Number(parsed.version) !== STATE_VERSION) return; // 别的版本不猜，重来

    // 时钟偏移：savedAt 领先当前时刻超过 5 分钟，说明这份文件不可信（换机 / 改过系统时间）。
    const savedAt = Number(parsed.savedAt);
    const t = now();
    if (Number.isFinite(savedAt) && savedAt - t > CLOCK_SKEW_MS) return;

    const src = parsed.entries;
    if (!src || typeof src !== "object" || Array.isArray(src)) return;

    for (const [rawId, raw] of Object.entries(src)) {
      const k = keyOf(rawId);
      if (!k || !raw || typeof raw !== "object") continue;
      const e = fresh();
      const f = Math.trunc(Number(raw.failures));
      e.failures = Number.isFinite(f) && f > 0 ? f : 0;
      const deadAt = Number(raw.deadAtMs);
      // 未来的 deadAtMs 是脏值（写成时钟问题），夹到当前时刻，别让它躲过 TTL。
      e.deadAtMs = Number.isFinite(deadAt) && deadAt > 0 ? Math.min(deadAt, t) : 0;
      e.lastStatus = Number(raw.lastStatus) || 0;
      e.lastCode = raw.lastCode == null ? "" : String(raw.lastCode);
      if (expired(e, t)) continue; // 例行清理：过期结论不续命
      entries.set(k, e);
    }
    trim();
    savedSignature = JSON.stringify(persistedEntries());
  }

  /** 状态真的变了才写一次；写失败（权限 / 磁盘满 / 只读）一律静默。 */
  function flush() {
    if (!persist) return;
    const entriesOut = persistedEntries();
    const sig = JSON.stringify(entriesOut);
    if (sig === savedSignature) return; // 内容没变：不产生写放大
    const payload = { version: STATE_VERSION, savedAt: now(), entries: entriesOut };
    try {
      try {
        fsImpl.mkdirSync(dirname(file), { recursive: true });
      } catch {
        // 目录建不出来就交给 writeFileSync 去失败，这里不再纠缠
      }
      fsImpl.writeFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
      savedSignature = sig;
    } catch {
      // 健康态是尽力而为的缓存：写不进去就当没写，绝不打断请求路径，也不更新指纹（下次再试）
    }
  }

  function record(modelId, ok, { status = 0, code = "" } = {}) {
    const k = keyOf(modelId);
    if (!k) return { dead: false, failures: 0 };
    const t = now();

    let e = entries.get(k);
    if (e) entries.delete(k); // 命中先摘掉，最后再插回队尾
    if (!e || expired(e, t)) e = fresh(); // 过期的旧结论不续命，从 1 重新数

    e.lastStatus = Number(status) || 0;
    e.lastCode = code == null ? "" : String(code);

    if (ok) {
      e.failures = 0;
      e.deadAtMs = 0;
    } else {
      e.failures += 1;
      if (e.failures >= threshold && !e.deadAtMs) {
        e.deadAtMs = t; // 首次判死的时间点；后续失败不刷新冷却
      }
    }

    entries.set(k, e);
    trim();
    flush(); // 只有内容真的变了才落盘
    return { dead: e.deadAtMs > 0, failures: e.failures };
  }

  function isDead(modelId) {
    const k = keyOf(modelId);
    if (!k) return false;
    const t = now();
    const e = entries.get(k);
    if (!e) return false;
    if (expired(e, t)) {
      entries.delete(k); // 冷却结束：忘掉这条结论，放它回去试
      return false;
    }
    entries.delete(k);
    entries.set(k, e); // 访问即刷新 LRU
    return e.deadAtMs > 0;
  }

  function state(modelId) {
    const k = keyOf(modelId);
    if (!k) return EMPTY_STATE();
    const t = now();
    const e = entries.get(k);
    if (!e) return EMPTY_STATE();
    if (expired(e, t)) {
      entries.delete(k);
      return EMPTY_STATE();
    }
    return {
      failures: e.failures,
      dead: e.deadAtMs > 0,
      sinceMs: e.deadAtMs,
      lastStatus: e.lastStatus,
      lastCode: e.lastCode,
    };
  }

  function snapshot() {
    const t = now();
    for (const [k, e] of [...entries]) {
      if (expired(e, t)) entries.delete(k); // 快照只报有效结论
    }
    const dead = [];
    const out = {};
    for (const [k, e] of entries) {
      const isD = e.deadAtMs > 0;
      if (isD) dead.push(k);
      out[k] = {
        failures: e.failures,
        dead: isD,
        sinceMs: e.deadAtMs,
        lastStatus: e.lastStatus,
        lastCode: e.lastCode,
      };
    }
    return { threshold, ttlMs: ttl, total: entries.size, dead, entries: out };
  }

  function reset() {
    entries.clear();
    flush(); // 清空也是状态变化，落盘（纯内存模式下 flush 直接短路）
  }

  loadFromDisk();

  return { record, isDead, state, snapshot, reset };
}
