import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHealthStore, HEALTH_DEFAULTS, healthStatePath } from "../src/health.mjs";

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

// ── 可选持久化 ───────────────────────────────────────────────────────────────
// 这些用例**只用注入的假 fs**，绝不碰真实磁盘（不写 ~/.config、不写 tmp）。

/** 固定时钟基准：比 1e6 大得多，方便构造「31 分钟前」这种正的 deadAtMs。 */
const T0 = 10_000_000_000;
const STATE_PATH = "/tmp/x/model-health.json";

/**
 * 假 fs：只实现 health.mjs 用的三个方法，记录每一次调用。
 * @param {{text?: string|null, writeThrows?: boolean}} [init] text=null 表示文件不存在
 */
function fakeFs({ text = null, writeThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    reads: () => calls.filter((c) => c.op === "readFileSync"),
    writes: () => calls.filter((c) => c.op === "writeFileSync"),
    mkdirs: () => calls.filter((c) => c.op === "mkdirSync"),
    readFileSync(path, enc) {
      calls.push({ op: "readFileSync", path, enc });
      if (text === null) {
        const e = new Error(`ENOENT: no such file or directory, open '${path}'`);
        e.code = "ENOENT";
        throw e;
      }
      return text;
    },
    writeFileSync(path, data, enc) {
      calls.push({ op: "writeFileSync", path, data, enc });
      if (writeThrows) {
        const e = new Error("EACCES: permission denied");
        e.code = "EACCES";
        throw e;
      }
    },
    mkdirSync(path, opts) {
      calls.push({ op: "mkdirSync", path, opts });
    },
  };
}

/** 固定时钟 + 落盘路径的 store（时间基准 T0）。 */
function persistingStore(fs, opts = {}) {
  return createHealthStore({ now: () => T0, stateFile: STATE_PATH, fs, ...opts });
}

test("health 持久化：stateFile 为空 / 空白 → 假 fs 一次都不被调用（纯内存不变）", () => {
  for (const stateFile of [undefined, "", "   ", null, 42]) {
    const fs = fakeFs({ text: "{}" });
    const store = createHealthStore({ failureThreshold: 1, now: () => T0, stateFile, fs });

    assert.deepEqual(store.record("a", false), { dead: true, failures: 1 });
    assert.equal(store.isDead("a"), true);
    store.snapshot();
    store.state("a");
    store.reset();

    assert.deepEqual(fs.calls, [], `stateFile=${JSON.stringify(stateFile)} 时不该有任何 fs 调用`);
  }
});

test("health 持久化：构造时读到既有结论 → isDead 命中、snapshot().dead 正确，且过期的条目被丢掉", () => {
  const text = JSON.stringify({
    version: 1,
    savedAt: T0 - 1_000,
    entries: {
      "m-dead": { failures: 3, deadAtMs: T0 - 60_000, lastStatus: 404, lastCode: "model_not_priced" },
      "m-alive": { failures: 1, deadAtMs: 0, lastStatus: 503, lastCode: "upstream_busy" },
      // 冷却早已结束（默认 ttl 30 分钟，这条 31 分钟前判死）→ 读进来就该被例行清理掉
      "m-stale": { failures: 9, deadAtMs: T0 - 31 * 60_000, lastStatus: 404, lastCode: "model_out_of_scope" },
    },
  });
  const fs = fakeFs({ text });
  const store = persistingStore(fs, { failureThreshold: 3 });

  assert.equal(fs.reads().length, 1, "构造时读一次");
  assert.equal(fs.reads()[0].path, STATE_PATH);
  assert.equal(fs.writes().length, 0, "构造阶段绝不写盘");

  assert.equal(store.isDead("m-dead"), true, "上次判死的模型重启后仍认");
  assert.deepEqual(store.snapshot().dead, ["m-dead"]);
  assert.equal(store.snapshot().total, 2, "过期条目被清理");
  assert.deepEqual(store.state("m-dead"), {
    failures: 3,
    dead: true,
    sinceMs: T0 - 60_000,
    lastStatus: 404,
    lastCode: "model_not_priced",
  });
  assert.equal(store.isDead("m-alive"), false, "只在计数没到阈值的模型不该判死");
  assert.equal(store.state("m-alive").lastCode, "upstream_busy");
  assert.deepEqual(store.state("m-stale"), {
    failures: 0,
    dead: false,
    sinceMs: 0,
    lastStatus: 0,
    lastCode: "",
  }, "过期结论按未知处理");
});

test("health 持久化：坏 JSON / 空对象 / 文件不存在 → 一律当空状态，不抛", () => {
  const cases = [
    ["坏 JSON", fakeFs({ text: '{"version":1,"entries":{' })],
    ["空串", fakeFs({ text: "" })],
    ["字符串 JSON", fakeFs({ text: '"nope"' })],
    ["数组 JSON", fakeFs({ text: "[1,2,3]" })],
    ["entries 是数组", fakeFs({ text: '{"version":1,"entries":[]}' })],
    ["版本不符", fakeFs({ text: '{"version":99,"savedAt":1,"entries":{"a":{"failures":9,"deadAtMs":1}}}' })],
    ["文件不存在", fakeFs()],
  ];
  for (const [label, fs] of cases) {
    const store = persistingStore(fs, { failureThreshold: 1 });
    assert.equal(store.snapshot().total, 0, `${label}：应当是空状态`);
    assert.deepEqual(store.snapshot().dead, [], `${label}：不该有 dead`);
    assert.equal(fs.writes().length, 0, `${label}：不该写盘`);
    // 空状态下 record 仍然正常工作
    assert.deepEqual(store.record("fresh", false), { dead: true, failures: 1 }, label);
  }
});

test("health 持久化：record 真的改变状态才写一次，落盘 JSON 有 version、不含 dead", () => {
  const fs = fakeFs();
  const store = persistingStore(fs, { failureThreshold: 2 });

  assert.equal(fs.writes().length, 0, "构造不写盘");

  store.record("m", false, { status: 503, code: "upstream_busy" });
  assert.equal(fs.writes().length, 1, "第一次失败：状态变了，写一次");
  store.record("m", false, { status: 404, code: "model_not_priced" });
  assert.equal(fs.writes().length, 2, "判死：又写一次");

  const last = fs.writes().at(-1);
  assert.equal(last.path, STATE_PATH);
  assert.equal(last.enc, "utf8");
  const written = JSON.parse(last.data);
  assert.equal(written.version, 1);
  assert.equal(typeof written.savedAt, "number");
  assert.deepEqual(Object.keys(written), ["version", "savedAt", "entries"]);
  assert.deepEqual(Object.keys(written.entries), ["m"]);
  assert.equal("dead" in written.entries.m, false, "dead 是派生值，不落盘");
  assert.deepEqual(Object.keys(written.entries.m).sort(), ["deadAtMs", "failures", "lastCode", "lastStatus"]);
  assert.equal(written.entries.m.failures, 2);
  assert.equal(written.entries.m.deadAtMs, T0, "首次判死的时刻");
  assert.equal(written.entries.m.lastStatus, 404);
  assert.equal(written.entries.m.lastCode, "model_not_priced");
  assert.deepEqual(fs.mkdirs()[0].opts, { recursive: true }, "写之前补目录");

  // 内容不变 → 不写放大（同样的 ok 记录连打两次，第二次不该产生新写入）
  store.record("stable", true, { status: 200, code: "ok" });
  const afterFirst = fs.writes().length;
  store.record("stable", true, { status: 200, code: "ok" });
  assert.equal(fs.writes().length, afterFirst, "内容一致不重复写");

  // 非法 id 直接短路，不产生任何写
  store.record("", false);
  store.record(null, false);
  assert.equal(fs.writes().length, afterFirst);
});

test("health 持久化：写盘抛异常被静默吞掉，record 仍返回正常结果", () => {
  const fs = fakeFs({ writeThrows: true });
  const store = persistingStore(fs, { failureThreshold: 1 });

  const r = store.record("m", false, { status: 404, code: "model_not_priced" });
  assert.deepEqual(r, { dead: true, failures: 1 }, "写失败不能影响返回值");
  assert.equal(fs.writes().length, 1, "确实尝试过写");
  assert.equal(store.isDead("m"), true, "内存态仍然生效");
  assert.deepEqual(store.snapshot().dead, ["m"]);
  assert.equal(store.record("m2", true).dead, false, "后续调用照常");
});

test("health 持久化：savedAt 领先当前时刻超过 5 分钟 → 整份忽略（时钟偏移）", () => {
  const entries = { "m-dead": { failures: 3, deadAtMs: T0 - 60_000, lastStatus: 404, lastCode: "x" } };

  const skewed = fakeFs({ text: JSON.stringify({ version: 1, savedAt: T0 + 5 * 60_000 + 1, entries }) });
  const ignored = persistingStore(skewed, { failureThreshold: 3 });
  assert.equal(ignored.snapshot().total, 0, "时钟偏移的文件整份不信");
  assert.equal(ignored.isDead("m-dead"), false);

  // 边界：正好 5 分钟以内照收
  const okFs = fakeFs({ text: JSON.stringify({ version: 1, savedAt: T0 + 5 * 60_000, entries }) });
  const kept = persistingStore(okFs, { failureThreshold: 3 });
  assert.equal(kept.snapshot().total, 1);
  assert.equal(kept.isDead("m-dead"), true);
});

test("health 持久化：reset 也落盘（清空是状态变化），纯内存模式下则一个调用都没有", () => {
  const fs = fakeFs();
  const store = persistingStore(fs, { failureThreshold: 1 });
  store.record("m", false);
  const before = fs.writes().length;

  store.reset();
  assert.equal(fs.writes().length, before + 1, "清空要落盘");
  const written = JSON.parse(fs.writes().at(-1).data);
  assert.deepEqual(written.entries, {});
  assert.equal(written.version, 1);
  assert.deepEqual(store.snapshot().dead, []);

  const memoryOnly = fakeFs();
  const mem = createHealthStore({ now: () => T0, fs: memoryOnly });
  mem.record("a", false);
  mem.reset();
  assert.deepEqual(memoryOnly.calls, []);
});

test("healthStatePath：拼出 <dir>/model-health.json，两平台都用 node:path 的 join", () => {
  assert.equal(healthStatePath("/tmp/x"), join("/tmp/x", "model-health.json"));
  assert.equal(healthStatePath("/tmp/x").endsWith("model-health.json"), true);
  assert.equal(healthStatePath("/tmp/x", "custom.json"), join("/tmp/x", "custom.json"));
  assert.equal(healthStatePath("/tmp/x", ""), join("/tmp/x", "model-health.json"), "空文件名回退默认");
  assert.equal(healthStatePath("  /tmp/x  "), join("/tmp/x", "model-health.json"), "两端空白被裁掉");

  // 非法入参一律空串：调用方据此当「不持久化」，不会拼出 "undefined/model-health.json"
  for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
    assert.equal(healthStatePath(bad), "", String(bad));
  }
});

