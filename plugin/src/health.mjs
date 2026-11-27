// src/health.mjs — 进程内模型健康快照：记下每个模型最近的成功/失败，连续失败到阈值就标 dead，
// provider.models 钩子据此把 status 改成 "deprecated"，宿主就不会再把请求路由给它。
//
// 为什么需要它（七牛实测，见 docs/troubleshooting.md）：91 个模型里有一批对本账号是「确定
// 不可用」——未标价的上游回 503（插件改判 404 model_not_priced），不在模型组的上游回 403
// （改判 404 model_out_of_scope）。现在只能撞了才知道：每次白等一个 RTT，还要把错误抛给用户。
// 把「撞过的结论」记下来，下一轮目录就能提前躲开，选模型时也不再撞雷。
//
// 为什么只在内存（不落盘）：结论有时效 —— 账号加钱、开白名单、上游补价之后模型就好了。一份
// 过期的状态文件会让插件永久拒绝一个其实可用的模型，代价远大于重新撞一次；进程随宿主重启，
// 内存态自然遗忘，等于自带「定期重新求证」。
//
// 语义：ok=true 清零（dead 一并清除，视为恢复）；ok=false 计数 +1，达到 failureThreshold 才
// dead；dead 之后 ttlMs 内 isDead() 为 true，过期则按「半信半疑」返回 false 并把这条记录丢掉
// （下次失败从 1 重新数）。调用方只该在 404/503/400 这类「确定不可用」上记失败 —— 限流、欠费
// 是账号级问题，归 breaker.mjs 管，记到这里会把好模型一起标死。

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_MODELS = 500;

/** 默认参数（只读，供集成方与诊断输出引用）。 */
export const HEALTH_DEFAULTS = Object.freeze({
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  ttlMs: DEFAULT_TTL_MS,
  maxModels: DEFAULT_MAX_MODELS,
});

const EMPTY_STATE = () => ({ failures: 0, dead: false, sinceMs: 0, lastStatus: 0, lastCode: "" });

/**
 * 建一个纯内存的模型健康仓库。
 *
 * @param {object} [init]
 * @param {number} [init.failureThreshold=3] 连续失败多少次判 dead（最小 1）
 * @param {number} [init.ttlMs=1800000]      dead 状态的冷却时长，过期即重新求证
 * @param {number} [init.maxModels=500]      最多记多少个模型，超出按 LRU 淘汰
 * @param {() => number} [init.now=Date.now] 可注入时钟（测试不要用真实时间）
 */
export function createHealthStore({
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  ttlMs = DEFAULT_TTL_MS,
  maxModels = DEFAULT_MAX_MODELS,
  now = Date.now,
} = {}) {
  const threshold = Math.max(1, Math.trunc(Number(failureThreshold) || 0));
  const ttl = Math.max(0, Math.trunc(Number(ttlMs) || 0));
  const cap = Math.max(1, Math.trunc(Number(maxModels) || 0));

  // Map 的插入顺序就是 LRU 顺序：命中时先 delete 再 set，把这条推到队尾。
  /** @type {Map<string, {failures:number, deadAtMs:number, lastStatus:number, lastCode:string}>} */
  const entries = new Map();

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
  }

  return { record, isDead, state, snapshot, reset };
}
