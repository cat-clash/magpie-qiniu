// plugin/tests/fix.test.mjs — options 自愈（planFix / applyPlan / describePlan）的单测。
// 铁律：这一层是纯逻辑，不碰 fs、不联网、不改本机 plugins.json。
// 跑法：node --test plugin/tests/fix.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlan, describePlan, isEmptyPlan, planFix } from "../src/fix.mjs";
import { LEGACY_OPTIONS, optionsAudit } from "../src/doctor.mjs";

/** 造一份「脏」的 options + 它的生效值，返回 { rawOptions, effective, audit }。 */
function dirtyFixture() {
  const rawOptions = {
    maxConcurrency: 4,
    baseUrl: "https://api.qnaigc.com/v1",
    chatTimeoutMs: 30_000,
    typoOption: true,
    breakerThreshold: 999,
    pacingMinMs: 800,
  };
  // 生效值：legacy / unknown 不出现，breakerThreshold 被夹到 100，其余原样
  const effective = {
    maxConcurrency: 4,
    breakerThreshold: 100,
    pacingMinMs: 800,
  };
  return { rawOptions, effective, audit: optionsAudit(rawOptions, effective) };
}

// ── planFix ─────────────────────────────────────────────────

test("planFix：legacy 与 unknown 都进 remove，clamped 进 set，其余进 keep", () => {
  const { rawOptions, effective, audit } = dirtyFixture();
  const plan = planFix({ rawOptions, audit, effective });

  assert.deepEqual(plan.remove, ["baseUrl", "chatTimeoutMs", "typoOption"]); // 排序去重
  assert.deepEqual(plan.set, { breakerThreshold: 100 });
  assert.deepEqual(plan.keep, ["maxConcurrency", "pacingMinMs"]);
  assert.equal(isEmptyPlan(plan), false);
});

test("planFix：reasons 逐条对得上 remove 与 set（--json 共用同一口径）", () => {
  const { rawOptions, effective, audit } = dirtyFixture();
  const plan = planFix({ rawOptions, audit, effective });

  assert.equal(plan.reasons.length, plan.remove.length + Object.keys(plan.set).length);
  assert.ok(plan.reasons.some((r) => r.includes("baseUrl") && r.includes("从未实现")));
  assert.ok(plan.reasons.some((r) => r.includes("typoOption") && r.includes("不认识")));
  assert.ok(plan.reasons.some((r) => r.includes("breakerThreshold") && r.includes("999") && r.includes("100")));
});

test("planFix：没有问题时 isEmptyPlan 为 true，三个字段都为空", () => {
  const rawOptions = { maxConcurrency: 4, breakerThreshold: 5 };
  const effective = { maxConcurrency: 4, breakerThreshold: 5 };
  const plan = planFix({ rawOptions, effective, audit: optionsAudit(rawOptions, effective) });

  assert.equal(isEmptyPlan(plan), true);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.set, {});
  assert.deepEqual(plan.keep, ["maxConcurrency", "breakerThreshold"]);
  assert.deepEqual(plan.reasons, []);
});

test("planFix：wrote 已经等于生效值时不算需要改", () => {
  // 手工喂一条 clamped，但 wrote 与生效值一致 → 不该产生 set
  const plan = planFix({
    rawOptions: { breakerThreshold: 100 },
    audit: { legacy: [], unknown: [], clamped: [{ key: "breakerThreshold", wrote: 100, effective: 100 }] },
    effective: { breakerThreshold: 100 },
  });
  assert.deepEqual(plan.set, {});
  assert.equal(isEmptyPlan(plan), true);
});

// ── applyPlan ───────────────────────────────────────────────

test("applyPlan：不改入参（原对象仍带脏键）", () => {
  const { rawOptions, effective, audit } = dirtyFixture();
  const snapshot = JSON.parse(JSON.stringify(rawOptions));
  const plan = planFix({ rawOptions, audit, effective });
  const next = applyPlan(rawOptions, plan);

  assert.deepEqual(rawOptions, snapshot); // 入参一字未动
  assert.equal(rawOptions.baseUrl, "https://api.qnaigc.com/v1"); // 脏键还在
  assert.equal(rawOptions.breakerThreshold, 999); // 原值还在
  assert.notEqual(next, rawOptions); // 返回的是新对象
  assert.equal(next.baseUrl, undefined); // 新对象里已经清掉
  assert.equal(next.breakerThreshold, 100);
});

test("applyPlan：保留未列入计划的键的值（包括嵌套对象）", () => {
  const rawOptions = {
    maxConcurrency: 2,
    stateDir: "D:/magpie/state",
    baseUrl: "https://old",
    modelOverrides: { "deepseek/deepseek-v4-flash": { ttl: 60 } },
  };
  const effective = { maxConcurrency: 2, stateDir: "D:/magpie/state", modelOverrides: { "deepseek/deepseek-v4-flash": { ttl: 60 } } };
  const plan = planFix({ rawOptions, effective, audit: optionsAudit(rawOptions, effective) });
  assert.deepEqual(plan.remove, ["baseUrl", "modelOverrides"]); // 两个都是 legacy

  // 只删 baseUrl，modelOverrides 手工放回计划外，验证嵌套值原样保留
  const next = applyPlan(rawOptions, { remove: ["baseUrl"], set: {}, keep: [] });
  assert.deepEqual(next.modelOverrides, { "deepseek/deepseek-v4-flash": { ttl: 60 } });
  assert.equal(next.stateDir, "D:/magpie/state");
  assert.equal(next.maxConcurrency, 2);
  assert.deepEqual(Object.keys(next), ["maxConcurrency", "stateDir", "modelOverrides"]); // 顺序不变
});

// ── describePlan ────────────────────────────────────────────

test("describePlan：每类问题都有可读文案，删除项列出键名", () => {
  const { rawOptions, effective, audit } = dirtyFixture();
  const lines = describePlan(planFix({ rawOptions, audit, effective }));

  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("删除从未实现的字段"));
  assert.match(lines[0], /baseUrl/);
  assert.match(lines[0], /chatTimeoutMs/);
  assert.ok(lines[1].startsWith("删除不认识的字段"));
  assert.match(lines[1], /typoOption/);
  assert.equal(lines[2], "breakerThreshold：999 → 100");
});

test("describePlan：空计划返回空数组", () => {
  assert.deepEqual(describePlan(planFix({ rawOptions: { maxConcurrency: 4 }, audit: optionsAudit({ maxConcurrency: 4 }, { maxConcurrency: 4 }) })), []);
  assert.deepEqual(describePlan(undefined), []);
});

// ── 边界 ────────────────────────────────────────────────────

test("边界：rawOptions 为空 / null / 非对象都不抛，且计划为空", () => {
  for (const raw of [{}, null, undefined, "oops", 42, [], true]) {
    const plan = planFix({ rawOptions: raw, audit: { legacy: [], unknown: [], clamped: [] }, effective: {} });
    assert.equal(isEmptyPlan(plan), true);
    assert.deepEqual(applyPlan(raw, plan), {});
    assert.deepEqual(describePlan(plan), []);
  }
});

test("边界：audit / effective 缺失也不抛（CLI 读到坏 plugins.json 时的退路）", () => {
  const plan = planFix({ rawOptions: { maxConcurrency: 4 } });
  assert.equal(isEmptyPlan(plan), true);
  assert.deepEqual(plan.keep, ["maxConcurrency"]);
  assert.deepEqual(applyPlan({ maxConcurrency: 4 }, undefined), { maxConcurrency: 4 });
});

// ── 端到端（纯逻辑层）─────────────────────────────────────────

test("端到端：baseUrl + breakerThreshold:999 走一圈，结果干净且其它键一字不动", () => {
  const rawOptions = {
    maxConcurrency: 6,
    baseUrl: "https://api.qnaigc.com/v1",
    quotaFailover: true,
    breakerThreshold: 999,
    pacingMinMs: 1200,
    keyLabel: "带脏键的账号",
  };
  const effective = {
    maxConcurrency: 6,
    quotaFailover: true,
    breakerThreshold: 100,
    pacingMinMs: 1200,
    keyLabel: "带脏键的账号",
  };

  const plan = planFix({ rawOptions, audit: optionsAudit(rawOptions, effective), effective });
  const next = applyPlan(rawOptions, plan);

  assert.ok(!("baseUrl" in next), "baseUrl 应该被删掉");
  assert.equal(next.breakerThreshold, 100);
  assert.equal(next.maxConcurrency, 6);
  assert.equal(next.quotaFailover, true);
  assert.equal(next.pacingMinMs, 1200);
  assert.equal(next.keyLabel, "带脏键的账号");
  assert.deepEqual(Object.keys(next), ["maxConcurrency", "quotaFailover", "breakerThreshold", "pacingMinMs", "keyLabel"]);
  // 删干净之后，再审计一次应该什么都不报
  assert.deepEqual(optionsAudit(next, effective), {
    unknown: [],
    legacy: [],
    clamped: [],
    knownKeys: Object.keys(effective),
  });
  // LEGACY_OPTIONS 里确实有 baseUrl，这条用例才有意义
  assert.ok(LEGACY_OPTIONS.includes("baseUrl"));
});
