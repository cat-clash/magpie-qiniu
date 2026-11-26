// src/pacing.mjs — 出站节奏闸：把请求在**发出前**拉开最小间隔并叠加随机抖动。
//
// 为什么需要它（七牛的限流维度，见 docs/troubleshooting.md §5）：
//   · TPM / RPM 是按**账号**的分钟级窗口，连发就是撞；撞上之后本轮请求已经失败，
//     再好的错误分档也只能事后补救。节奏闸是预防：让每分钟的请求分布先落回限额内。
//   · TPD 是日窗口，节奏闸帮不上，那交给 breaker.mjs 止损。
//
// 语义（与 magpie-marvis 的 pacing 同构，便于两个插件的运维经验互相复用）：
//   · wait() 先**同步占位**再异步等待 —— JS 单线程保证占位原子，并发调用方按调用顺序
//     落在同一条时间轴上，相邻两次放行的间隔不小于 minMs。
//   · 不做互斥队列：每个调用方各睡各的，醒来即出网，互不交接。
//   · 每次放行（含首次）额外叠加 random() * jitterMs —— 把固定间隔打散成随机分布，
//     也把进程刚启动时的第一批请求错开。
//   · 按账号桶隔离：A 号在等间隔时 B 号立刻能走（magpie 一次只把当前账号交给我们，
//     但同一个进程里会有多个账号轮流过来）。无 key 的调用落在 "*" 桶。
//   · 纯内存、零 IO、零依赖；now / random / sleep 都可注入，单测不需要真实等待。
//
// 关掉：minMs=0 只关间隔闸（抖动仍生效）；jitterMs=0 只关抖动；两者都 0 = 完全直通。

const GLOBAL_KEY = "*";

/**
 * @param {object} init
 * @param {number} [init.minMs]      相邻放行的最小间隔（毫秒），0 = 关闭间隔闸
 * @param {number} [init.jitterMs]   每次放行的随机抖动上限（毫秒），0 = 关闭抖动
 * @param {() => number} [init.now]
 * @param {() => number} [init.random]
 * @param {(ms: number) => Promise<void>} [init.sleep]
 */
export function createPacing({ minMs = 0, jitterMs = 0, now = Date.now, random = Math.random, sleep } = {}) {
  const minGap = Math.max(0, Number(minMs) || 0);
  const jitter = Math.max(0, Number(jitterMs) || 0);
  const doSleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const axes = new Map(); // key -> 上次占位的时刻
  let totalWaits = 0;
  let totalWaitMs = 0;

  return {
    minMs: minGap,
    jitterMs: jitter,

    /** 等到该账号的下一个放行槽位。返回本次实际等待的毫秒数（0 = 立即放行）。 */
    async wait(key = GLOBAL_KEY) {
      const bucket = String(key || GLOBAL_KEY);
      const t = now();
      const jitterMs = jitter > 0 ? random() * jitter : 0;
      // 同步占位：本次请求的槽位 = max(现在, 上次槽位 + minGap) + jitter
      const prev = axes.get(bucket);
      // 首次（该桶还没有槽位）立刻放行，只叠加抖动；之后按 minGap 累进
      const slot = (prev === undefined ? t : Math.max(t, prev + minGap)) + jitterMs;
      axes.set(bucket, slot);
      const delay = Math.max(0, slot - t);
      if (delay > 0) {
        totalWaits += 1;
        totalWaitMs += delay;
        await doSleep(delay);
      }
      return delay;
    },

    /** 诊断用：某个桶上次占位的时间戳。 */
    lastSlot(key = GLOBAL_KEY) {
      return axes.get(String(key || GLOBAL_KEY));
    },

    stats() {
      return {
        minMs: minGap,
        jitterMs: jitter,
        buckets: axes.size,
        waits: totalWaits,
        waitMs: Math.round(totalWaitMs),
      };
    },

    /** 单测用：清空时间轴与计数。 */
    reset() {
      axes.clear();
      totalWaits = 0;
      totalWaitMs = 0;
    },
  };
}

export { GLOBAL_KEY };
