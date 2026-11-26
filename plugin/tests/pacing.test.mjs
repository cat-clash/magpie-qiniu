import test from "node:test";
import assert from "node:assert/strict";
import { createPacing, GLOBAL_KEY } from "../src/pacing.mjs";

/**
 * 固定时钟 + 固定随机 + 记录 sleep：单测不真实等待。
 * 默认 sleep **不**推进时钟 —— 这样断言的是「同一瞬间涌进来的 N 个请求按顺序占槽」，
 * 也就是节奏闸真正要解决的问题（并发打穿 TPM 窗口）。
 */
function makePacing({ minMs, jitterMs, randomValue = 0, advanceClockOnSleep = false } = {}) {
  let t = 1_000_000;
  const slept = [];
  const pacing = createPacing({
    minMs,
    jitterMs,
    now: () => t,
    random: () => randomValue,
    sleep: async (ms) => {
      slept.push(ms);
      if (advanceClockOnSleep) t += ms;
    },
  });
  return { pacing, slept };
}

test("pacing：关闭时完全直通，不产生任何等待", async () => {
  const { pacing, slept } = makePacing({ minMs: 0, jitterMs: 0 });
  for (let i = 0; i < 3; i += 1) assert.equal(await pacing.wait("a"), 0);
  assert.deepEqual(slept, []);
});

test("pacing：并发涌入同一账号时按 minMs 逐个排队（0 / 100 / 200）", async () => {
  const { pacing, slept } = makePacing({ minMs: 100, jitterMs: 0 });
  assert.equal(await pacing.wait("a"), 0);
  assert.equal(await pacing.wait("a"), 100);
  assert.equal(await pacing.wait("a"), 200);
  assert.deepEqual(slept, [100, 200]);
});

test("pacing：串行调用（等完再发）每次只等一个间隔，不会越等越久", async () => {
  const { pacing } = makePacing({ minMs: 100, jitterMs: 0, advanceClockOnSleep: true });
  assert.equal(await pacing.wait("a"), 0);
  assert.equal(await pacing.wait("a"), 100);
  assert.equal(await pacing.wait("a"), 100);
});

test("pacing：抖动叠加在槽位上（random=0.5 时每次 +jitter/2）", async () => {
  const { pacing } = makePacing({ minMs: 100, jitterMs: 400, randomValue: 0.5 });
  assert.equal(await pacing.wait("a"), 200); // 首次也要抖：把启动后的第一批请求错开
  // 槽位 = 上次槽位 + minGap + 抖动，所以相邻间隔 = 100 + 200，抖动只会拉长、不会缩短
  assert.equal(await pacing.wait("a"), 500);
});

test("pacing：桶之间互相独立，一个账号慢不拖累另一个", async () => {
  const { pacing } = makePacing({ minMs: 100, jitterMs: 0 });
  assert.equal(await pacing.wait("a"), 0);
  assert.equal(await pacing.wait("b"), 0, "b 号第一条不该被 a 号的间隔拖住");
  assert.equal(await pacing.wait("a"), 100);
  assert.equal(await pacing.wait("b"), 100);
});

test("pacing：缺省桶是 *，空 key 不会被当成独立账号", async () => {
  const { pacing } = makePacing({ minMs: 50, jitterMs: 0 });
  assert.equal(await pacing.wait(), 0);
  assert.equal(await pacing.wait(""), 50);
  assert.equal(await pacing.wait(GLOBAL_KEY), 100);
});

test("pacing：stats 汇总桶数与累计等待，reset 清空", async () => {
  const { pacing } = makePacing({ minMs: 100, jitterMs: 0 });
  await pacing.wait("a");
  await pacing.wait("a"); // 等 100
  await pacing.wait("b"); // 首条，不等
  const s = pacing.stats();
  assert.equal(s.minMs, 100);
  assert.equal(s.buckets, 2);
  assert.equal(s.waits, 1);
  assert.equal(s.waitMs, 100);
  pacing.reset();
  assert.equal(pacing.stats().buckets, 0);
  assert.equal(await pacing.wait("a"), 0, "reset 后重新从零开始");
});
