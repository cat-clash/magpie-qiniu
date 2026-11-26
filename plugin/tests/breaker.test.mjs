import test from "node:test";
import assert from "node:assert/strict";
import { createBreaker, isAccountLevelFailure, GLOBAL_KEY } from "../src/breaker.mjs";

/** 可控时钟 + 固定随机（0.5 → jitter 系数 1.0，冷却时长可精确断言）。 */
function makeBreaker({ threshold = 3, cooldownMs = 60_000, maxCooldownMs = 8 * 60 * 60_000 } = {}) {
  let t = 1_000_000;
  const breaker = createBreaker({
    threshold,
    cooldownMs,
    maxCooldownMs,
    now: () => t,
    random: () => 0.5,
  });
  return { breaker, advance: (ms) => (t += ms), now: () => t };
}

test("breaker：连续失败到阈值才开闸，之前照常放行", () => {
  const { breaker } = makeBreaker({ threshold: 3 });
  assert.equal(breaker.blockedFor("a"), 0);
  assert.deepEqual(breaker.record("a", false), { closed: true, opened: false });
  assert.deepEqual(breaker.record("a", false), { closed: true, opened: false });
  assert.equal(breaker.blockedFor("a"), 0, "没到阈值不该拦");
  const third = breaker.record("a", false);
  assert.equal(third.opened, true);
  assert.equal(third.cooldownMs, 60_000);
  assert.equal(breaker.blockedFor("a"), 60_000);
});

test("breaker：中途一次成功就清零，失败计数不累积到下一次", () => {
  const { breaker } = makeBreaker({ threshold: 2 });
  breaker.record("a", false);
  breaker.record("a", true);
  assert.deepEqual(breaker.record("a", false), { closed: true, opened: false });
  assert.equal(breaker.blockedFor("a"), 0);
});

test("breaker：冷却到期进半开，探测成功关闭并清零退避链", () => {
  const { breaker, advance } = makeBreaker({ threshold: 1, cooldownMs: 60_000 });
  breaker.record("a", false);
  assert.equal(breaker.blockedFor("a"), 60_000);
  advance(60_000);
  assert.equal(breaker.blockedFor("a"), 0, "冷却到期后放行探测");
  breaker.record("a", true);
  assert.equal(breaker.state("a").open, false);
  assert.equal(breaker.state("a").opens, 0, "关闭后退避链清零");
});

test("breaker：半开探测失败立刻重开，冷却翻倍（指数退避）", () => {
  const { breaker, advance } = makeBreaker({ threshold: 1, cooldownMs: 60_000 });
  breaker.record("a", false);
  advance(60_000);
  const again = breaker.record("a", false);
  assert.equal(again.opened, true);
  assert.equal(again.cooldownMs, 120_000, "第二次熔断是 base×2^1");
  advance(120_000);
  const third = breaker.record("a", false);
  assert.equal(third.cooldownMs, 240_000);
});

test("breaker：冷却时长封顶在 maxCooldownMs", () => {
  const { breaker, advance } = makeBreaker({ threshold: 1, cooldownMs: 60_000, maxCooldownMs: 100_000 });
  breaker.record("a", false);
  advance(60_000);
  const again = breaker.record("a", false);
  assert.equal(again.cooldownMs, 100_000, "2×base 超上限时按上限算");
});

test("breaker：按账号分桶，一个号熔断不影响别的号", () => {
  const { breaker } = makeBreaker({ threshold: 1 });
  breaker.record("a", false);
  assert.ok(breaker.blockedFor("a") > 0);
  assert.equal(breaker.blockedFor("b"), 0);
});

test("breaker：threshold=0 完全禁用（blockedFor 恒 0、record 不记账）", () => {
  const { breaker } = makeBreaker({ threshold: 0 });
  for (let i = 0; i < 10; i += 1) breaker.record("a", false);
  assert.equal(breaker.blockedFor("a"), 0);
  assert.equal(breaker.stats().buckets, 0);
});

test("breaker：空 key 落到 * 桶，不会各开一条时间轴", () => {
  const { breaker } = makeBreaker({ threshold: 1 });
  breaker.record("", false);
  assert.ok(breaker.blockedFor(GLOBAL_KEY) > 0);
  assert.ok(breaker.blockedFor("") > 0);
});

test("breaker：stats 只列当前真正开着的桶", () => {
  const { breaker, advance } = makeBreaker({ threshold: 1, cooldownMs: 60_000 });
  breaker.record("a", false);
  assert.deepEqual(breaker.stats().open, ["a"]);
  advance(60_000);
  assert.deepEqual(breaker.stats().open, []);
});

test("isAccountLevelFailure：只有账号级状态码算，模型级与网络错误不算", () => {
  for (const s of [401, 402, 403, 429]) assert.equal(isAccountLevelFailure(s), true, String(s));
  for (const s of [400, 404, 500, 503, 0]) assert.equal(isAccountLevelFailure(s), false, String(s));
});
