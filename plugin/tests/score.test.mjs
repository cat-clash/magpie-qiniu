import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, DEFAULT_LIMITS as CATALOG_LIMITS, FREE_IDS, UPSTREAM_FACTS, VISION_IDS } from "../src/catalog.mjs";
import {
  CAPS,
  DEFAULT_LIMITS,
  PROFILES,
  PROFILE_WEIGHTS,
  capabilityScore,
  compareProfiles,
  contextScore,
  explain,
  outputScore,
  priceScore,
  rankModels,
  scoreModel,
  tagsOf,
} from "../src/score.mjs";

/** 造一条最小模型条目；不传的字段就是「缺失」，用来测脏数据。 */
function model(patch = {}) {
  return {
    id: "test/model",
    name: "Test Model",
    context: 128_000,
    output: 8_192,
    vision: false,
    reasoning: false,
    free: false,
    rate: 1,
    toolCall: true,
    note: "",
    ...patch,
  };
}

test("contextScore：0 / 缺失 / 负数 / NaN 一律按 DEFAULT_LIMITS 兜底，且与显式 128K 同分", () => {
  const base = contextScore(model({ context: DEFAULT_LIMITS.context }));
  assert.ok(base > 0 && base < 1, `128K 应落在 (0,1)，实际 ${base}`);
  assert.equal(contextScore(model({ context: 0 })), base, "context=0 要兜底成 128K");
  assert.equal(contextScore(model({ context: undefined })), base, "context 缺失要兜底成 128K");
  assert.equal(contextScore(model({ context: -5 })), base, "负数是脏值");
  assert.equal(contextScore(model({ context: Number.NaN })), base, "NaN 是脏值");
  assert.equal(contextScore(model({ context: "0" })), base, "字符串 0 也是脏值");
});

test("contextScore：极大值夹到 1.0，且单调递增", () => {
  assert.equal(contextScore(model({ context: CAPS.context })), 1);
  assert.equal(contextScore(model({ context: 10_000_000 })), 1, "超 cap 夹到 1");
  const small = contextScore(model({ context: 40_000 }));
  const mid = contextScore(model({ context: 262_144 }));
  const big = contextScore(model({ context: 1_048_576 }));
  assert.ok(small < mid && mid <= big, `应单调：${small} < ${mid} <= ${big}`);
  assert.equal(big, 1, "1M 以上就是满分");
});

test("outputScore：0 与缺失兜底为 8192，≥128K 饱和为 1", () => {
  const base = outputScore(model({ output: DEFAULT_LIMITS.output }));
  assert.equal(outputScore(model({ output: 0 })), base);
  assert.equal(outputScore(model({ output: undefined })), base);
  assert.equal(outputScore(model({ output: 128_000 })), 1);
  assert.equal(outputScore(model({ output: 1_048_576 })), 1, "超 cap 夹到 1");
  assert.ok(outputScore(model({ output: 4_096 })) < base, "4K 输出应低于 8K");
});

test("priceScore：free 命中得 1，rate<=0 得 1，付费 0", () => {
  assert.equal(priceScore(model({ free: true, rate: 0 })), 1);
  assert.equal(priceScore(model({ free: true, rate: 1 })), 1, "免费位优先于 rate");
  assert.equal(priceScore(model({ free: false, rate: 0 })), 1, "rate=0 视作折扣位");
  assert.equal(priceScore(model({ free: false, rate: 1 })), 0);
  assert.equal(priceScore(model({ free: undefined, rate: undefined })), 0, "缺失不能当免费");
  assert.equal(priceScore(null), 0);
});

test("capabilityScore：coding 下 no-tools 砍半，vision profile 下非视觉只有 0.1", () => {
  const tools = model({ toolCall: true, reasoning: true });
  const noTools = model({ toolCall: false, reasoning: true });
  assert.equal(capabilityScore(tools, "coding"), 1, "tools+reasoning 满分");
  assert.ok(capabilityScore(noTools, "coding") < capabilityScore(tools, "coding"));
  assert.equal(capabilityScore(model({ toolCall: false, reasoning: false }), "coding"), 0.3, "两个位都没有 = 0.3");

  assert.equal(capabilityScore(model({ vision: true }), "vision"), 1);
  assert.equal(capabilityScore(model({ vision: false }), "vision"), 0.1);
  assert.equal(capabilityScore(model({ free: true, rate: 0 }), "cheap"), 1, "cheap 的能力分就是价格分");
  assert.throws(() => capabilityScore(model(), "nope"), TypeError, "未知 profile 必须抛");
});

test("PROFILES / 权重：五个档位齐全，每个档位四维权重和为 1", () => {
  assert.deepEqual(PROFILES, ["balanced", "coding", "long-context", "vision", "cheap"]);
  for (const p of PROFILES) {
    const w = PROFILE_WEIGHTS[p];
    const sum = w.context + w.output + w.price + w.capability;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${p} 权重和应为 1，实际 ${sum}`);
  }
  assert.equal(DEFAULT_LIMITS.context, CATALOG_LIMITS.context, "兜底口径必须与 catalog.mjs 一致");
  assert.equal(DEFAULT_LIMITS.output, CATALOG_LIMITS.output, "兜底口径必须与 catalog.mjs 一致");
});

test("scoreModel：分数等于四维加权和，脏数据在 parts.notes 里留痕", () => {
  const clean = scoreModel(model({ id: "a", context: 262_144, output: 64_000 }), "balanced");
  const w = PROFILE_WEIGHTS.balanced;
  const expect = w.context * clean.parts.context + w.output * clean.parts.output + w.price * clean.parts.price + w.capability * clean.parts.capability;
  assert.ok(Math.abs(clean.score - expect) < 1e-6, `加权和应等于总分：${clean.score} vs ${expect}`);
  assert.deepEqual(clean.parts.notes, [], "干净数据不留痕");

  const dirty = scoreModel(model({ id: "b", context: 0, output: 0 }), "balanced");
  assert.equal(dirty.parts.notes.length, 2, "context 与 output 各留一条");
  assert.ok(dirty.parts.notes.some((n) => n.includes("context") && n.includes("131072")));
  assert.ok(dirty.parts.notes.some((n) => n.includes("output") && n.includes("8192")));
  assert.ok(dirty.score > 0 && dirty.score < 1);
});

test("rankModels：limit 生效、exclude 生效、同分按 id 升序", () => {
  const same = [
    model({ id: "zeta", context: 200_000 }),
    model({ id: "alpha", context: 200_000 }),
    model({ id: "mike", context: 200_000 }),
  ];
  const r = rankModels(same, { profile: "balanced", limit: 3 });
  assert.deepEqual(r.map((x) => x.id), ["alpha", "mike", "zeta"], "同分按 id 升序");

  const limited = rankModels(CATALOG, { profile: "balanced", limit: 5 });
  assert.equal(limited.length, 5);
  assert.equal(rankModels(CATALOG, { profile: "balanced", limit: 0 }).length, CATALOG.length, "limit<=0 = 全量");

  const excluded = rankModels(CATALOG, { profile: "balanced", limit: 5, exclude: ["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro-highspeed"] });
  assert.equal(excluded.length, 5);
  assert.ok(!excluded.some((x) => x.id === "moonshotai/kimi-k3.1-pro"));
  assert.ok(!excluded.some((x) => x.id === "moonshotai/kimi-k3.1-pro-highspeed"));
  // Set 与数组两种 exclude 写法等价
  const asSet = rankModels(CATALOG, { profile: "balanced", limit: 5, exclude: new Set(["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro-highspeed"]) });
  assert.deepEqual(asSet.map((x) => x.id), excluded.map((x) => x.id));

  assert.deepEqual(rankModels([], { limit: 5 }), [], "空输入不抛");
  assert.deepEqual(rankModels([null, undefined, 5, { id: "" }], { limit: 5 }), [], "垃圾条目被跳过");
  assert.throws(() => rankModels(CATALOG, { profile: "bogus" }), TypeError);
});

test("cheap profile：全部 5 条免费模型都排在所有付费模型之前", () => {
  const ranked = rankModels(CATALOG, { profile: "cheap", limit: CATALOG.length });
  const freeCount = ranked.filter((r) => FREE_IDS.has(r.id)).length;
  assert.equal(freeCount, FREE_IDS.size, `免费条目应全部在榜：${freeCount} vs ${FREE_IDS.size}`);
  const paidScores = ranked.filter((r) => !FREE_IDS.has(r.id)).map((r) => r.score);
  const freeScores = ranked.filter((r) => FREE_IDS.has(r.id)).map((r) => r.score);
  assert.ok(
    Math.min(...freeScores) > Math.max(...paidScores),
    `免费最低分 ${Math.min(...freeScores)} 必须高于付费最高分 ${Math.max(...paidScores)}`,
  );
  assert.deepEqual(
    ranked.slice(0, FREE_IDS.size).every((r) => FREE_IDS.has(r.id)),
    true,
    "前 5 名必须全是免费模型",
  );
});

test("vision profile：非视觉模型分数明显低于任意视觉模型", () => {
  const vision = CATALOG.filter((m) => m.vision === true);
  const blind = CATALOG.filter((m) => m.vision !== true);
  assert.ok(vision.length > 0 && blind.length > 0);
  let minVision = 1;
  for (const m of vision) minVision = Math.min(minVision, scoreModel(m, "vision").score);
  let maxBlind = 0;
  for (const m of blind) maxBlind = Math.max(maxBlind, scoreModel(m, "vision").score);
  assert.ok(minVision > maxBlind, `视觉最低 ${minVision} 应高于非视觉最高 ${maxBlind}`);

  const top = rankModels(CATALOG, { profile: "vision", limit: 5 });
  assert.equal(top.every((r) => r.tags.includes("vision")), true, "vision 榜前 5 必须都有 vision 标签");
  assert.equal(top.every((r) => VISION_IDS.has(r.id)), true);
});

test("coding profile：no-tools 的唯一模型排在同等条件带工具调用的模型之后", () => {
  const rows = rankModels(CATALOG, { profile: "coding", limit: CATALOG.length });
  const noTools = rows.findIndex((r) => r.tags.includes("no-tools"));
  assert.ok(noTools >= 0, "目录里应有 no-tools 条目（doubao-1.5-vision-pro）");
  const sameContextTools = rows.findIndex((r) => r.id === "doubao-1.5-pro-32k" && r.tags.includes("tools"));
  assert.ok(noTools > sameContextTools, `no-tools 位次 ${noTools} 应晚于带工具调用的 ${sameContextTools}`);
  assert.ok(rows[noTools].parts.capability < 0.6, "no-tools 的能力分必须 <0.6");
});

test("compareProfiles：每个 profile 都给 3 条且档内不重复", () => {
  const all = compareProfiles(CATALOG);
  assert.deepEqual(Object.keys(all).sort(), [...PROFILES].sort());
  for (const p of PROFILES) {
    assert.equal(all[p].length, 3, `${p} 应有 3 条`);
    const ids = all[p].map((x) => x.id);
    assert.equal(new Set(ids).size, 3, `${p} 档内不能重复：${ids.join(",")}`);
    for (const row of all[p]) {
      assert.ok(row.score >= 0 && row.score <= 1);
      assert.equal(typeof row.name, "string");
      assert.ok(row.name.length > 0);
    }
  }
});

test("explain：返回非空行，含具体数字与兜底说明", () => {
  const lines = explain(CATALOG[0], "coding");
  assert.ok(Array.isArray(lines) && lines.length >= 5);
  assert.ok(lines.every((l) => typeof l === "string" && l.trim().length > 0));
  const text = lines.join("\n");
  assert.match(text, /总分\s+0\.\d{4}/, "要给出四位小数的总分");
  assert.match(text, /profile=coding/);
  assert.match(text, /权重\s+55%/, "coding 的 capability 权重是 55%");

  // 上游原始 0 值条目（在线 /v1/models 的形状）必须打印兜底行
  const dirty = explain(model({ context: 0, output: 0 }), "balanced");
  assert.ok(dirty.some((l) => l.startsWith("兜底：")), `应有兜底行：\n${dirty.join("\n")}`);
  assert.ok(dirty.some((l) => l.includes("131072")), "兜底行要点出 131072");
});

test("tagsOf：免费 / 视觉 / 工具 / 1M / 兜底 标签都能打出来", () => {
  const free = tagsOf(model({ free: true, rate: 0, vision: true, toolCall: true, context: 1_048_576 }));
  assert.ok(free.includes("free"));
  assert.ok(free.includes("vision"));
  assert.ok(free.includes("tools"));
  assert.ok(free.includes("1M-ctx"));
  const dirty = tagsOf(model({ context: 0, output: 0, toolCall: false }));
  assert.ok(dirty.includes("ctx-fallback"));
  assert.ok(dirty.includes("out-fallback"));
  assert.ok(dirty.includes("no-tools"));
  assert.deepEqual(tagsOf(null), []);
});

test("真实目录：91 条全量打分，无 NaN、无越界、limit=5 恰好 5 条", () => {
  assert.equal(CATALOG.length, UPSTREAM_FACTS.TOTAL, "目录条数应等于 UPSTREAM_FACTS.TOTAL");
  const top5 = rankModels(CATALOG, { limit: 5 });
  assert.equal(top5.length, 5);

  for (const profile of PROFILES) {
    const rows = rankModels(CATALOG, { profile, limit: CATALOG.length });
    assert.equal(rows.length, CATALOG.length, `${profile} 应覆盖全部 ${CATALOG.length} 条`);
    for (const r of rows) {
      assert.equal(Number.isNaN(r.score), false, `${r.id} 的 score 是 NaN`);
      for (const key of ["context", "output", "price", "capability"]) {
        const v = r.parts[key];
        assert.equal(Number.isFinite(v), true, `${r.id} 的 parts.${key} 不是有限数`);
        assert.ok(v >= 0 && v <= 1, `${r.id} 的 parts.${key}=${v} 越界`);
      }
      assert.ok(r.score >= 0 && r.score <= 1, `${r.id} 的 score=${r.score} 越界`);
    }
    // 排序必须单调不增
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score, `${profile} 排序不单调`);
  }
});

test("真实目录：上游 0 值已换成兜底值并留了 note 标记，原始 0 值条目按同分兜底", () => {
  // catalog.mjs 把上游 0 换成了 DEFAULT_LIMITS 并打标记，所以静态目录里不该再有 0
  assert.equal(CATALOG.filter((m) => !(Number(m.context) > 0)).length, 0, "静态目录里的 context 已全部兜底");
  assert.equal(CATALOG.filter((m) => !(Number(m.output) > 0)).length, 0, "静态目录里的 output 已全部兜底");
  assert.equal(CATALOG.filter((m) => /ctx-0/.test(m.note)).length, UPSTREAM_FACTS.ZERO_CONTEXT_LENGTH);
  assert.equal(CATALOG.filter((m) => /upstream-0/.test(m.note)).length, UPSTREAM_FACTS.ZERO_MAX_TOKENS);

  // 但把上游原始 0 值喂进来，分数必须与目录里那条的兜底值一致，并留痕
  const air = CATALOG.find((m) => m.id === "z-ai/glm-4.5-air-free");
  assert.equal(air.context, DEFAULT_LIMITS.context, "该条 context 应已回退成 128K");
  const raw = scoreModel({ ...air, context: 0, output: 0 });
  const fixed = scoreModel(air);
  assert.equal(raw.score, fixed.score, "原始 0 值与目录兜底值必须同分");
  assert.equal(raw.parts.notes.length, 2, "context 与 output 各留一条兜底留痕");
  for (const m of CATALOG.filter((e) => /upstream-0|ctx-0/.test(e.note))) {
    assert.ok(scoreModel(m).parts.context > 0, `${m.id} 的 context 分不应为 0`);
  }
});
