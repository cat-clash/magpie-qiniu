// src/breaker.mjs — 账号级熔断器：被上游明确拒绝（限流 / 欠费 / 鉴权）之后先在本机停下，
// 别让宿主对着同一个账号连撞。
//
// 为什么需要它（七牛实测，见 docs/troubleshooting.md §5 与 KNOWN_ISSUES BUG #6）：
//   · TPD 是按**账号**的日 token 限额，撞上之后当天怎么重试都失败；magpie 宿主拿到 429
//     会按自己的策略退避重试，它不知道这是"日窗口"，也不知道这个账号刚才连续失败了几次。
//   · 欠费停用（403 account_billing_suspended）同理：结清账单前每一次请求都是白撞。
//   · 插件侧唯一能做的止损就是本地熔断：连续失败到阈值 → open（本地直接回 429 + retry-after），
//     冷却到期 → half-open（放行一个探测），探测成功关闭、失败立刻重开并翻倍退避。
//
// 状态机（与 magpie-marvis 的 breaker 同构）：
//   closed ──连续失败达 threshold──> open ──冷却到期──> half-open ──record(true)──> closed
//                                        ▲                          │
//                                        └──── record(false) 立即重开 ┘（opens+1，冷却翻倍）
//   · 指数退避：cooldown = min(cooldownMs * 2^opens, maxCooldownMs)，叠加 ±10% jitter。
//     opens = 本轮连续熔断中的重开次数；record(true) 关闭时清零。
//     默认序列（threshold 5 / 30min 基准）：30min → 1h → 2h → 4h → 8h（封顶）。
//   · jitter 在熔断那一刻定死，冷却期内 retryAfter 稳定可读；进程重启后重新随机。
//   · 按账号分桶：一个号被限流只冷却这个号，兄弟账号照常出网。
//     magpie 一次只把当前账号交给插件（loader 的 getAuth），但同一进程里会有多个账号轮流过来。
//   · 纯内存（本次迭代不落盘：插件进程随宿主重启，旧冷却自然失效 —— 宁可少冷却一次，
//     也不要让一份过期状态文件把账号锁死）。
//
// 哪些失败算「账号级」（这三类才会进熔断）：401 鉴权、402 余额、403 欠费/停用/Key 额度、
// 429 限流。模型级问题（404 未标价、模型不在订阅组）不算 —— 换模型就能好，不该动账号。

const GLOBAL_KEY = "*";
const DEFAULT_MAX_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const JITTER_RATIO = 0.1;
const MAX_EVENTS = 20;

/** 账号级失败的状态码集合。404/501 这类模型问题不在内，网络错误（0）也不算。 */
export function isAccountLevelFailure(status) {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

/**
 * @param {object} init
 * @param {number} [init.threshold]    连续失败多少次后熔断（0 = 禁用）
 * @param {number} [init.cooldownMs]   首次熔断的冷却时长
 * @param {number} [init.maxCooldownMs] 指数退避上限
 * @param {() => number} [init.now]
 * @param {() => number} [init.random]
 */
export function createBreaker({
  threshold = 5,
  cooldownMs = 30 * 60 * 1000,
  maxCooldownMs = DEFAULT_MAX_COOLDOWN_MS,
  now = Date.now,
  random = Math.random,
} = {}) {
  const limit = Math.max(0, Math.trunc(Number(threshold) || 0));
  const base = Math.max(1_000, Number(cooldownMs) || 0);
  const cap = Math.max(base, Number(maxCooldownMs) || DEFAULT_MAX_COOLDOWN_MS);
  const buckets = new Map(); // key -> { failures, opens, openedAt, cooldownUntilMs }
  const events = [];

  function bucketOf(key) {
    const k = String(key || GLOBAL_KEY);
    let b = buckets.get(k);
    if (!b) {
      b = { failures: 0, opens: 0, openedAt: 0, cooldownUntilMs: 0 };
      buckets.set(k, b);
    }
    return b;
  }

  function cooldownFor(opens) {
    const raw = Math.min(cap, base * 2 ** Math.max(0, opens));
    const jitter = raw * JITTER_RATIO * (random() * 2 - 1); // ±10%
    return Math.max(1_000, Math.round(raw + jitter));
  }

  function note(type, key, extra = {}) {
    events.push({ at: now(), type, key, ...extra });
    while (events.length > MAX_EVENTS) events.shift();
  }

  return {
    threshold: limit,
    cooldownMs: base,
    maxCooldownMs: cap,

    /**
     * 该账号还要等多久（毫秒）。0 = 可以出网（closed，或 half-open 探测窗口）。
     */
    blockedFor(key) {
      if (!limit) return 0;
      const b = buckets.get(String(key || GLOBAL_KEY));
      if (!b || !b.openedAt) return 0;
      const left = b.cooldownUntilMs - now();
      return left > 0 ? left : 0;
    },

    /**
     * 记一笔结果。ok=true 会关闭熔断并清零退避链。
     * @returns {{closed:boolean, opened:boolean, cooldownMs?:number}}
     */
    record(key, ok) {
      if (!limit) return { closed: true, opened: false };
      const k = String(key || GLOBAL_KEY);
      const b = bucketOf(k);
      const t = now();
      const halfOpen = b.openedAt > 0 && b.cooldownUntilMs <= t;

      if (ok) {
        const wasOpen = b.openedAt > 0;
        b.failures = 0;
        b.opens = 0;
        b.openedAt = 0;
        b.cooldownUntilMs = 0;
        if (wasOpen) note("close", k);
        return { closed: true, opened: false };
      }

      if (halfOpen) {
        // 探测失败：立即重开，退避翻倍
        b.opens += 1;
        b.openedAt = t;
        b.cooldownUntilMs = t + cooldownFor(b.opens);
        note("reopen", k, { opens: b.opens, cooldownMs: b.cooldownUntilMs - t });
        return { closed: false, opened: true, cooldownMs: b.cooldownUntilMs - t };
      }

      b.failures += 1;
      if (b.failures >= limit) {
        b.opens = 0;
        b.openedAt = t;
        b.cooldownUntilMs = t + cooldownFor(0);
        b.failures = 0;
        note("open", k, { cooldownMs: b.cooldownUntilMs - t });
        return { closed: false, opened: true, cooldownMs: b.cooldownUntilMs - t };
      }
      return { closed: true, opened: false };
    },

    /** 诊断快照。 */
    state(key) {
      const b = buckets.get(String(key || GLOBAL_KEY));
      if (!b) return { failures: 0, opens: 0, open: false, retryAfterMs: 0 };
      const left = b.openedAt ? Math.max(0, b.cooldownUntilMs - now()) : 0;
      return { failures: b.failures, opens: b.opens, open: b.openedAt > 0 && left > 0, retryAfterMs: left };
    },

    stats() {
      return {
        threshold: limit,
        cooldownMs: base,
        maxCooldownMs: cap,
        buckets: buckets.size,
        open: [...buckets.entries()].filter(([, b]) => b.openedAt && b.cooldownUntilMs > now()).map(([k]) => k),
        events: events.slice(-5),
      };
    },

    reset() {
      buckets.clear();
      events.length = 0;
    },
  };
}

export { GLOBAL_KEY };
