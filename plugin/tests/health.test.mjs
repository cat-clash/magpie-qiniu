import { test } from "node:test";
import assert from "node:assert/strict";
import { createHealthStore, HEALTH_DEFAULTS } from "../src/health.mjs";

/** 可控时钟：所有用例都用注入的 now，绝不碰真实时间。 */
function makeStore(opts = {}) {
  let t = 1_000_000;
  const store = createHealthStore({ ...opts, now: () => t });
  return { store, advance: (ms) => (t += ms), now: () => t };
}

test("health：连续失败到阈值才 dead，前两次不 dead", () => {
  const { store } = makeStore({ failureThreshold: 3 });

  const first = store.record("qwen-max", false, { status: 404, code: "model_not_priced" });
  assert.deepEqual(first, { dead: false, failures: 1 });
  assert.equal(store.isDead("qwen-max"), false);

  const second = store.record("qwen-max", false, { status: 503, code: "upstream_unavailable" });
  assert.deepEqual(second, { dead: false, failures: 2 });
  assert.equal(store.isDead("qwen-max"), false, "没到阈值不该标死");

  const third = store.record("qwen-max", false, { status: 404, code: "model_out_of_scope" });
  assert.deepEqual(third, { dead: true, failures: 3 });
  assert.equal(store.isDead("qwen-max"), true);
  assert.equal(store.state("qwen-max").lastStatus, 404);
  assert.equal(store.state("qwen-max").lastCode, "model_out_of_scope");
});

test("health：中途一次成功清零计数，下一次失败从 1 重新数", () => {
  const { store } = makeStore({ failureThreshold: 2 });

  store.record("glm-4", false);
  store.record("glm-4", true, { status: 200, code: "ok" });
  assert.deepEqual(store.state("glm-4"), {
    failures: 0,
    dead: false,
    sinceMs: 0,
    lastStatus: 200,
    lastCode: "ok",
  });

  const again = store.record("glm-4", false, { status: 404, code: "model_not_priced" });
  assert.deepEqual(again, { dead: false, failures: 1 }, "清零后的第一次失败只是 1");
  assert.equal(store.isDead("glm-4"), false);
});

test("health：dead 之后一次成功即恢复（dead 标记与计数一起清）", () => {
  const { store } = makeStore({ failureThreshold: 2 });

  store.record("deepseek-v3", false);
  store.record("deepseek-v3", false);
  assert.equal(store.isDead("deepseek-v3"), true);
  assert.ok(store.state("deepseek-v3").sinceMs > 0);

  const recovered = store.record("deepseek-v3", true);
  assert.deepEqual(recovered, { dead: false, failures: 0 });
  assert.equal(store.isDead("deepseek-v3"), false);
  assert.deepEqual(store.snapshot().dead, [], "恢复后不再出现在 dead 列表");
});

test("health：ttl 过期后 isDead 变 false，并把过期结论丢掉", () => {
  const { store, advance } = makeStore({ failureThreshold: 1, ttlMs: 60_000 });

  store.record("kimi-k2", false, { status: 503 });
  assert.equal(store.isDead("kimi-k2"), true);

  advance(59_999);
  assert.equal(store.isDead("kimi-k2"), true, "冷却未到期仍然 dead");

  advance(1);
  assert.equal(store.isDead("kimi-k2"), false, "冷却到期按半信半疑放行");
  assert.deepEqual(store.state("kimi-k2"), {
    failures: 0,
    dead: false,
    sinceMs: 0,
    lastStatus: 0,
    lastCode: "",
  }, "过期记录已被清理");

  const retest = store.record("kimi-k2", false, { status: 503 });
  assert.deepEqual(retest, { dead: true, failures: 1 }, "重新求证：失败从 1 数起");
});

test("health：dead 期间继续失败不刷新 sinceMs，冷却从首次判死算起", () => {
  const { store, advance } = makeStore({ failureThreshold: 2, ttlMs: 60_000 });

  store.record("m1", false);
  store.record("m1", false);
  const since = store.state("m1").sinceMs;
  assert.ok(since > 0);

  advance(10_000);
  store.record("m1", false);
  assert.equal(store.state("m1").sinceMs, since, "sinceMs 保持不变");

  advance(50_000);
  assert.equal(store.isDead("m1"), false, "距首次判死满 ttl 即失效");
});

test("health：reset 清空所有模型与 dead 列表", () => {
  const { store } = makeStore({ failureThreshold: 1 });
  store.record("a", false);
  store.record("b", false);
  assert.equal(store.snapshot().total, 2);
  assert.deepEqual(store.snapshot().dead, ["a", "b"]);

  store.reset();

  const snap = store.snapshot();
  assert.deepEqual(snap, { threshold: 1, ttlMs: 30 * 60_000, total: 0, dead: [], entries: {} });
  assert.equal(store.isDead("a"), false);
  assert.deepEqual(store.state("b"), { failures: 0, dead: false, sinceMs: 0, lastStatus: 0, lastCode: "" });
});

test("health：maxModels 超限时淘汰最久没被访问的那个（LRU）", () => {
  const { store } = makeStore({ failureThreshold: 5, maxModels: 3 });

  store.record("a", false);
  store.record("b", false);
  store.record("c", false);
  assert.equal(store.snapshot().total, 3);

  store.record("a", false); // 命中 a，把 a 推回队尾，最久未访问变成 b
  store.record("d", false); // 插入 d，淘汰 b

  const snap = store.snapshot();
  assert.equal(snap.total, 3);
  assert.deepEqual(Object.keys(snap.entries).sort(), ["a", "c", "d"]);
  assert.deepEqual(store.state("b"), {
    failures: 0,
    dead: false,
    sinceMs: 0,
    lastStatus: 0,
    lastCode: "",
  }, "被淘汰的模型回到未知状态");
});

test("health：isDead 命中也算一次访问，能救活 LRU 里的边缘模型", () => {
  const { store } = makeStore({ failureThreshold: 1, maxModels: 2, ttlMs: 60_000 });

  store.record("a", false);
  store.record("b", false);
  assert.equal(store.isDead("a"), true); // 访问 a
  store.record("c", false); // 淘汰 b

  assert.deepEqual(Object.keys(store.snapshot().entries).sort(), ["a", "c"]);
  assert.equal(store.isDead("a"), true, "a 还在，且仍是 dead");
});

test("health：非法 modelId（空串 / 空白 / null / 数字 / 对象）一律忽略", () => {
  const { store } = makeStore({ failureThreshold: 1 });

  for (const bad of ["", "   ", null, undefined, 42, {}, [], true]) {
    assert.deepEqual(store.record(bad, false), { dead: false, failures: 0 }, String(bad));
    assert.equal(store.isDead(bad), false, String(bad));
    assert.deepEqual(store.state(bad), {
      failures: 0,
      dead: false,
      sinceMs: 0,
      lastStatus: 0,
      lastCode: "",
    }, String(bad));
  }

  assert.equal(store.snapshot().total, 0, "一条都没记进去");
});

test("health：不传 options 的 record 也安全，状态只读不炸", () => {
  const { store } = makeStore({ failureThreshold: 1 });
  assert.deepEqual(store.record("x", true), { dead: false, failures: 0 });
  assert.deepEqual(store.record("x", false), { dead: true, failures: 1 });
  assert.equal(store.state("x").lastStatus, 0);
  assert.equal(store.state("x").lastCode, "");
  assert.equal(store.isDead("never-seen"), false);
});

test("health：snapshot 形状固定且纯 JSON 可序列化", () => {
  const { store } = makeStore({ failureThreshold: 2, ttlMs: 1_000 });
  store.record("a", false, { status: 404, code: "model_not_priced" });
  store.record("a", false, { status: 404, code: "model_not_priced" });
  store.record("b", true, { status: 200, code: "ok" });

  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ["dead", "entries", "threshold", "total", "ttlMs"]);
  assert.equal(snap.threshold, 2);
  assert.equal(snap.ttlMs, 1_000);
  assert.equal(snap.total, 2);
  assert.deepEqual(snap.dead, ["a"]);
  assert.deepEqual(snap.entries.a, {
    failures: 2,
    dead: true,
    sinceMs: store.state("a").sinceMs,
    lastStatus: 404,
    lastCode: "model_not_priced",
  });
  assert.deepEqual(snap.entries.b, {
    failures: 0,
    dead: false,
    sinceMs: 0,
    lastStatus: 200,
    lastCode: "ok",
  });

  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round, snap, "JSON 往返不丢信息");
  assert.equal(typeof round.entries.a.sinceMs, "number");
  assert.equal(typeof round.entries.a.dead, "boolean");
});

test("health：snapshot 不报告已过冷却的结论", () => {
  const { store, advance } = makeStore({ failureThreshold: 1, ttlMs: 1_000 });
  store.record("a", false);
  assert.deepEqual(store.snapshot().dead, ["a"]);

  advance(1_000);
  const snap = store.snapshot();
  assert.deepEqual(snap.dead, []);
  assert.equal(snap.total, 0, "过期条目在快照里也被清掉");
});

test("HEALTH_DEFAULTS：默认值与文档一致且不可被改写", () => {
  assert.deepEqual(HEALTH_DEFAULTS, { failureThreshold: 3, ttlMs: 30 * 60_000, maxModels: 500 });
  assert.equal(Object.isFrozen(HEALTH_DEFAULTS), true);

  const { store } = makeStore();
  store.record("a", false);
  store.record("a", false);
  store.record("a", false);
  assert.equal(store.isDead("a"), true, "默认阈值 3");
  const snap = store.snapshot();
  assert.equal(snap.threshold, HEALTH_DEFAULTS.failureThreshold);
  assert.equal(snap.ttlMs, HEALTH_DEFAULTS.ttlMs);
});
