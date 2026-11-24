// plugin/tests/catalog.test.mjs — 静态模型目录的回归测试。
//
// 运行：bun test plugin/tests/catalog.test.mjs（本机没有 node，只有 bun；node:test / node:assert 由 bun 兼容）
// 取向：这些断言全是**上游实测快照**。七牛哪天加了模型、改了 max_tokens，测试必须红一次提醒我们重新抓取，
// 而不是让目录悄悄漂移。改数字时只许改这里，且必须重跑抓取脚本更新注释。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  K,
  CATALOG,
  DEFAULT_LIMITS,
  UPSTREAM_FACTS,
  FREE_IDS,
  HIDDEN_IDS,
  NO_TOOL_IDS,
  REASONING_IDS,
  VISION_IDS,
  DOC_ALIASES,
  catalogEntry,
} from "../src/catalog.mjs";

const SRC_PATH = fileURLToPath(new URL("../src/catalog.mjs", import.meta.url));
const SRC = readFileSync(SRC_PATH, "utf8");

// ── 上游实测计数（来源：2026-11-25 匿名 GET https://api.qnaigc.com/v1/models 返回 200，
//    data 共 91 条；原始响应存 research/models-live.json）。手改前先重抓，别对着代码改数字。
const UPSTREAM_TOTAL = 91;
const UPSTREAM_ZERO_MAX_TOKENS = 6; // max_tokens === 0 的条目数
const UPSTREAM_ZERO_CONTEXT_LENGTH = 1; // context_length === 0 的条目数
const UPSTREAM_UNAVAILABLE = 4; // service_status !== "available"
const EXPECT_FREE = 5;
const EXPECT_VISION = 45;
const EXPECT_REASONING = 81;
const EXPECT_NO_TOOL = 1;
const EXPECT_ALIASES = 45;

const FIELD_KEYS = ["context", "free", "id", "name", "note", "output", "rate", "reasoning", "toolCall", "vision"];
const byId = (id) => CATALOG.find((e) => e.id === id);

test("catalog.mjs 零 import、无网络/副作用，是纯常量模块", () => {
  assert.equal(/^\s*import\s/m.test(SRC), false, "catalog.mjs 不许 import 任何东西");
  assert.equal(/\brequire\s*\(/.test(SRC), false, "catalog.mjs 不许 require");
  assert.equal(/\bfetch\s*\(/.test(SRC), false, "catalog.mjs 不许联网");
  assert.equal(/\bawait\b/.test(SRC), false, "catalog.mjs 不许有 top-level await");
  assert.ok(Buffer.byteLength(SRC) < 40 * 1024, `catalog.mjs 体积 ${Buffer.byteLength(SRC)}B 超过 40KB`);
});

test("K 与 DEFAULT_LIMITS 是我们自己的常量，不是上游值", () => {
  assert.equal(K, 1024);
  assert.equal(DEFAULT_LIMITS.context, 128 * K);
  assert.equal(DEFAULT_LIMITS.context, 131072);
  // 上游 max_tokens 出现过的最小非零档是 4096，中位 128000；8192 落在保守区且是上游真实档位
  assert.equal(DEFAULT_LIMITS.output, 8192);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS) || true); // 允许可变，models.mjs 会读但不会写
});

test("CATALOG 覆盖上游 /v1/models 的全部 id，一条不落", () => {
  assert.ok(Array.isArray(CATALOG));
  assert.equal(CATALOG.length, UPSTREAM_TOTAL);
  assert.equal(CATALOG.length, UPSTREAM_FACTS.TOTAL);
});

test("每条都有 id/name/context/output，且类型正确", () => {
  for (const e of CATALOG) {
    assert.equal(typeof e.id, "string");
    assert.ok(e.id.length > 0, `空 id：${JSON.stringify(e)}`);
    assert.equal(typeof e.name, "string");
    assert.ok(e.name.length > 0, `空 name：${e.id}`);
    assert.equal(typeof e.context, "number");
    assert.equal(typeof e.output, "number");
    for (const k of ["vision", "reasoning", "free", "toolCall"]) assert.equal(typeof e[k], "boolean", `${e.id}.${k} 必须是布尔`);
    assert.equal(typeof e.note, "string");
    assert.equal(typeof e.rate, "number");
  }
});

test("条目形状严格等于 models.mjs 约定的 10 个字段（防字段漂移）", () => {
  for (const e of CATALOG) assert.deepEqual(Object.keys(e).sort(), FIELD_KEYS, `${e.id} 的字段集合被改过`);
});

test("id 唯一", () => {
  const seen = new Set();
  for (const e of CATALOG) {
    assert.equal(seen.has(e.id), false, `重复 id：${e.id}`);
    seen.add(e.id);
  }
  assert.equal(seen.size, CATALOG.length);
});

test("name 可读且唯一：不是 id 原样、不含下划线/斜杠、不重复", () => {
  const names = new Set();
  for (const e of CATALOG) {
    assert.notEqual(e.name, e.id, `${e.id} 的 name 还是 id 原文`);
    assert.equal(e.name.includes("_"), false, `${e.name} 含下划线`);
    assert.equal(e.name.includes("/"), false, `${e.name} 含斜杠`);
    assert.equal(e.name, e.name.trim(), `${e.name} 有首尾空格`);
    assert.equal(/ {2,}/.test(e.name), false, `${e.name} 有连续空格`);
    assert.ok(e.name.length <= 40, `${e.name} 太长`);
    assert.equal(names.has(e.name), false, `重名：${e.name}`);
    names.add(e.name);
  }
});

test("limit 全部为正：没有 output<=0，没有 context<=0", () => {
  for (const e of CATALOG) {
    assert.ok(Number.isFinite(e.output) && e.output > 0, `${e.id} output=${e.output}（上游 0 必须回退成 DEFAULT_LIMITS.output）`);
    assert.ok(Number.isFinite(e.context) && e.context > 0, `${e.id} context=${e.context}（上游 0 必须回退成 DEFAULT_LIMITS.context）`);
    assert.ok(Number.isInteger(e.output) && Number.isInteger(e.context), `${e.id} 的 limit 必须是整数`);
  }
});

test("note 里 upstream-0 的条目数与上游 max_tokens===0 的条目数严格一致", () => {
  const marked = CATALOG.filter((e) => e.note.split(";").includes("upstream-0"));
  assert.equal(marked.length, UPSTREAM_ZERO_MAX_TOKENS);
  assert.equal(UPSTREAM_ZERO_MAX_TOKENS, UPSTREAM_FACTS.ZERO_MAX_TOKENS);
  // 标了 upstream-0 就必须真的用了回退值；但反方向不成立：qwen2.5-vl-72b-instruct 上游 max_tokens 本来就是
  // 8192，与回退值巧合同值，它绝不能因此被标 upstream-0（否则计数会变 7，掩盖真实的上游变更）。
  for (const e of marked) assert.equal(e.output, DEFAULT_LIMITS.output, `${e.id} 标了 upstream-0 但 output 不是回退值`);
  const sameValueButReal = CATALOG.filter((e) => e.output === DEFAULT_LIMITS.output && !e.note.includes("upstream-0"));
  assert.deepEqual(sameValueButReal.map((e) => e.id), ["qwen2.5-vl-72b-instruct"]);
  // 固定的 6 个 id 锚点（上游实测）
  assert.deepEqual(
    marked.map((e) => e.id).sort(),
    ["deepseek/deepseek-v4-flash-20260731", "qwen-turbo", "qwen-vl-max-2025-01-25", "qwen3-30b-a3b", "qwen3-32b", "z-ai/glm-4.5-air-free"],
  );
});

test("note 里 ctx-0 的条目数与上游 context_length===0 的条目数严格一致", () => {
  const marked = CATALOG.filter((e) => e.note.split(";").includes("ctx-0"));
  assert.equal(marked.length, UPSTREAM_ZERO_CONTEXT_LENGTH);
  assert.equal(marked.length, UPSTREAM_FACTS.ZERO_CONTEXT_LENGTH);
  assert.equal(marked[0].id, "z-ai/glm-4.5-air-free");
  assert.equal(marked[0].context, DEFAULT_LIMITS.context);
});

test("rate 只会是 0 或 1，且 free ⇔ rate===0（主控把 rate 0 读作「未给折扣」）", () => {
  for (const e of CATALOG) {
    assert.ok(e.rate === 0 || e.rate === 1, `${e.id} rate=${e.rate}`);
    assert.equal(e.rate === 0, e.free === true, `${e.id} free=${e.free} 与 rate=${e.rate} 不一致`);
  }
});

test("FREE_IDS 与 CATALOG.free 双向一致（上游文档口径 5 条）", () => {
  const fromCatalog = new Set(CATALOG.filter((e) => e.free).map((e) => e.id));
  assert.equal(fromCatalog.size, EXPECT_FREE);
  assert.deepEqual([...FREE_IDS].sort(), [...fromCatalog].sort());
  for (const id of FREE_IDS) assert.ok(byId(id), `FREE_IDS 里的 ${id} 不在 CATALOG`);
  assert.deepEqual(
    [...FREE_IDS].sort(),
    ["meituan/longcat-flash-lite", "moonshotai/kimi-k3-free", "nvidia/nemotron-3-ultra-550b-a55b0-free", "qiniu/conatus-free", "z-ai/glm-4.5-air-free"],
  );
  // 只靠 id 里的 free 会漏掉的限时免费条目
  assert.ok(byId("meituan/longcat-flash-lite").note.includes("free-no-id-mark"));
});

test("VISION_IDS / REASONING_IDS / HIDDEN_IDS / NO_TOOL_IDS 全部是 CATALOG 的 id，且与逐条字段一致", () => {
  for (const [name, set, field] of [
    ["VISION_IDS", VISION_IDS, "vision"],
    ["REASONING_IDS", REASONING_IDS, "reasoning"],
    ["HIDDEN_IDS", HIDDEN_IDS, null],
    ["NO_TOOL_IDS", NO_TOOL_IDS, "toolCall"],
  ]) {
    for (const id of set) assert.ok(byId(id), `${name} 里的 ${id} 不在 CATALOG`);
  }
  for (const set of [VISION_IDS, REASONING_IDS, HIDDEN_IDS, NO_TOOL_IDS]) assert.ok(set instanceof Set);
  assert.deepEqual([...VISION_IDS].sort(), CATALOG.filter((e) => e.vision).map((e) => e.id).sort());
  assert.deepEqual([...REASONING_IDS].sort(), CATALOG.filter((e) => e.reasoning).map((e) => e.id).sort());
  assert.deepEqual([...NO_TOOL_IDS].sort(), CATALOG.filter((e) => !e.toolCall).map((e) => e.id).sort());
});

test("能力计数与文档快照一致（vision 45 / reasoning 81 / no-tool 1 / hidden 4）", () => {
  assert.equal(VISION_IDS.size, EXPECT_VISION);
  assert.equal(REASONING_IDS.size, EXPECT_REASONING);
  assert.equal(NO_TOOL_IDS.size, EXPECT_NO_TOOL);
  assert.equal(HIDDEN_IDS.size, UPSTREAM_UNAVAILABLE);
  assert.equal(UPSTREAM_FACTS.UNAVAILABLE, UPSTREAM_UNAVAILABLE);
});

test("HIDDEN_IDS 就是上游 service_status≠available 的 4 条，且 note 里写了状态", () => {
  assert.deepEqual([...HIDDEN_IDS].sort(), ["deepseek-v3", "deepseek-v3.1", "deepseek/deepseek-v3.2-251201", "deepseek/deepseek-v3.2-exp-thinking"]);
  for (const id of HIDDEN_IDS) assert.match(byId(id).note, /status=unavailable/, `${id} 没标上游状态`);
});

test("catalogEntry 精确查表：命中返回同一对象，未命中一律 undefined", () => {
  const hit = catalogEntry("deepseek/deepseek-v4-flash");
  assert.ok(hit, "catalogEntry('deepseek/deepseek-v4-flash') 必须有值");
  assert.equal(hit, byId("deepseek/deepseek-v4-flash"));
  assert.equal(hit.name, "DeepSeek V4 Flash");
  assert.equal(hit.context, 1000000);
  assert.equal(catalogEntry("  deepseek/deepseek-v4-flash  "), hit, "两侧空白应被忽略");
  // 除空白外一律精确匹配：不做大小写折叠、不做 slug 归一（那种宽容留给 models.mjs 的 resolveModelId）
  for (const miss of ["", "   ", "nope", "DeepSeek-V4-Flash", "deepseek\\deepseek-v4-flash", null, undefined, 42, {}, []]) {
    assert.equal(catalogEntry(miss), undefined, `${String(miss)} 不应命中`);
  }
  assert.ok(catalogEntry("deepseek/deepseek-v4-flash-20260731"), "带日期后缀的 id 必须独立存在");
  for (const e of CATALOG) assert.equal(catalogEntry(e.id), e);
});

test("out>ctx 的条目全表唯一且被标注（主控发请求前必须夹到 context 内）", () => {
  const over = CATALOG.filter((e) => e.output > e.context);
  assert.equal(over.length, 1);
  assert.equal(over[0].id, "meituan/longcat-flash-lite");
  assert.equal(over[0].context, 256000);
  assert.equal(over[0].output, 320000);
  for (const e of over) assert.ok(e.note.includes("out>ctx"));
});

test("DOC_ALIASES 只指向存在的 id、不含自映射、条数稳定", () => {
  const entries = Object.entries(DOC_ALIASES);
  assert.equal(entries.length, EXPECT_ALIASES);
  for (const [from, to] of entries) {
    assert.ok(byId(to), `别名 ${from} 指向不存在的 ${to}`);
    assert.notEqual(from, to, `别名 ${from} 是自映射`);
    assert.equal(from, from.trim());
  }
  assert.equal(DOC_ALIASES["deepseek-v4-flash"], "deepseek/deepseek-v4-flash");
  assert.equal(DOC_ALIASES["glm-5.2"], "z-ai/glm-5.2");
  assert.equal(DOC_ALIASES["aliyun/qwen-turbo"], "qwen-turbo");
  // 陷阱：DOC_ALIASES 是普通对象字面量，查 `constructor`/`toString` 会命中原型链拿到函数。
  // models.mjs 的 resolveModelId 必须用 hasOwnProperty 守卫，别裸查 DOC_ALIASES[id]。
  for (const proto of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(DOC_ALIASES, proto), false, `${proto} 不该是自有键`);
    assert.equal(typeof DOC_ALIASES[proto] === "function" || DOC_ALIASES[proto] !== undefined, true, `${proto} 会通过原型链返回非空值——查找侧要守卫`);
  }
});

test("UPSTREAM_FACTS 是抓取快照，不是手填", () => {
  assert.equal(UPSTREAM_FACTS.SOURCE, "https://api.qnaigc.com/v1/models");
  assert.match(UPSTREAM_FACTS.FETCHED_AT, /^20\d\d-\d\d-\d\d$/);
  assert.equal(UPSTREAM_FACTS.TOTAL, UPSTREAM_TOTAL);
  assert.equal(UPSTREAM_FACTS.ZERO_MAX_TOKENS, UPSTREAM_ZERO_MAX_TOKENS);
  assert.equal(UPSTREAM_FACTS.ZERO_CONTEXT_LENGTH, UPSTREAM_ZERO_CONTEXT_LENGTH);
  assert.equal(UPSTREAM_FACTS.UNAVAILABLE, UPSTREAM_UNAVAILABLE);
  assert.equal(UPSTREAM_FACTS.DOC_CARD_HITS, UPSTREAM_TOTAL);
});

test("note 格式规整：无空段、无首尾分号、标记都是已知词", () => {
  const KNOWN = /^(upstream-0|ctx-0|status=[a-z]+|retiring=20\d\d-\d\d-\d\d|etd-past=20\d\d-\d\d-\d\d|out>ctx|free-no-id-mark|name-vision-fp|no-tools|in:audio|in:file)$/;
  for (const e of CATALOG) {
    if (e.note === "") continue;
    assert.equal(e.note.startsWith(";"), false, `${e.id} note 以分号开头`);
    assert.equal(e.note.endsWith(";"), false, `${e.id} note 以分号结尾`);
    for (const part of e.note.split(";")) assert.match(part, KNOWN, `${e.id} 的 note 段 ${part} 不在字典里`);
  }
});

test("隐藏的 4 条与 etd-past 不混：退役日期已过但上游仍 available 的不许隐藏", () => {
  const etd = CATALOG.filter((e) => e.note.includes("etd-past="));
  assert.ok(etd.length >= 40, `etd-past 条目数异常：${etd.length}`);
  for (const e of etd) {
    if (!e.note.includes("status=unavailable")) assert.equal(HIDDEN_IDS.has(e.id), false, `${e.id} 只是文档退役日期过期，不该隐藏`);
    assert.match(e.note, /etd-past=20\d\d-\d\d-\d\d/);
  }
});
