// plugin/tests/models.test.mjs — 模型合成层的回归测试。
//
// 运行：bun test plugin/tests/models.test.mjs（本机没有 node；node:test / node:assert 由 bun 兼容）
// 取向：按 plugin/src/models.mjs 的真实导出测。静态表来自 catalog.mjs，在线表来自 research/models-live.json；
// 两者都必须经过 modelEntry 产出同一种 Model 形状，避免宿主路由/预算读到半成品。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MODELS_URL,
  EXTRA_CATALOG,
  modelEntry,
  staticModelTable,
  activeCount,
  parseLiveModels,
  resolveModelId,
  CATALOG,
  catalogEntry,
  DOC_ALIASES,
  DEFAULT_LIMITS,
  FREE_IDS,
  HIDDEN_IDS,
  NO_TOOL_IDS,
  REASONING_IDS,
  VISION_IDS,
} from "../src/models.mjs";
import {
  SDK,
  SDK_ANTHROPIC,
  INFER_BASE,
  BYPASS_ANTHROPIC_ORIGIN,
  BYPASS_ANTHROPIC_PATH,
  ANTHROPIC_VERSION,
} from "../src/config.mjs";

const LIVE_PATH = fileURLToPath(new URL("../../research/models-live.json", import.meta.url));
const LIVE = JSON.parse(readFileSync(LIVE_PATH, "utf8"));

const CHAT_URL = `${INFER_BASE}/chat/completions`;
const BYPASS_URL = `${BYPASS_ANTHROPIC_ORIGIN}${BYPASS_ANTHROPIC_PATH}`;
const MODALITIES = ["text", "image", "audio", "video", "pdf"];

const sortedIds = (table) => Object.keys(table).sort();
const cloneLive = () => JSON.parse(JSON.stringify(LIVE));
const findLive = (id) => LIVE.data.find((item) => item.id === id);

test("models.mjs 的导出名与 MODELS_URL 命中源码契约", () => {
  for (const [name, value] of [
    ["modelEntry", modelEntry],
    ["staticModelTable", staticModelTable],
    ["activeCount", activeCount],
    ["parseLiveModels", parseLiveModels],
    ["resolveModelId", resolveModelId],
  ]) assert.equal(typeof value, "function", `${name} 必须是函数`);

  assert.equal(MODELS_URL, `${INFER_BASE}/models`);
  assert.ok(Array.isArray(EXTRA_CATALOG));
  assert.equal(EXTRA_CATALOG.length, 3);
  assert.ok(Array.isArray(CATALOG));
  assert.equal(typeof catalogEntry, "function");
  assert.equal(DOC_ALIASES["GLM-5.3"], "z-ai/glm-5.3");
});

test("staticModelTable 总数 91、active 87、隐藏 4，且目录再导出计数一致", () => {
  const table = staticModelTable();
  const entries = Object.values(table);

  assert.equal(Object.keys(table).length, 91);
  assert.equal(Object.keys(table).length, CATALOG.length);
  assert.equal(activeCount(table), 87);
  assert.equal(entries.filter((m) => m.status === "active").length, 87);
  assert.equal(entries.filter((m) => m.status === "deprecated").length, 4);
  assert.deepEqual(
    entries.filter((m) => m.status === "deprecated").map((m) => m.id).sort(),
    [...HIDDEN_IDS].sort(),
  );
  assert.equal(entries.filter((m) => m.free).length, 5);
  assert.equal(entries.filter((m) => m.free).length, FREE_IDS.size);
  assert.equal(entries.filter((m) => m.capabilities.reasoning).length, 81);
  assert.equal(entries.filter((m) => m.capabilities.reasoning).length, REASONING_IDS.size);
  assert.equal(entries.filter((m) => m.capabilities.attachment).length, 45);
  assert.equal(entries.filter((m) => m.capabilities.attachment).length, VISION_IDS.size);
  assert.equal(entries.filter((m) => m.capabilities.toolcall === false).length, NO_TOOL_IDS.size);
});

test("静态表每条 Model 的 api、cost、limit 与 capabilities 形态齐全", () => {
  const table = staticModelTable();
  assert.equal(Object.keys(table).length, 91);

  for (const [id, m] of Object.entries(table)) {
    assert.equal(m.id, id);
    assert.equal(m.api.npm, SDK, `${id}.api.npm`);
    assert.equal(m.api.url, CHAT_URL, `${id}.api.url`);

    assert.deepEqual(Object.keys(m.cost).sort(), ["cache", "input", "output"], `${id}.cost 字段`);
    assert.equal(m.cost.input, 0, `${id}.cost.input`);
    assert.equal(m.cost.output, 0, `${id}.cost.output`);
    assert.equal(m.cost.cache.read, 0, `${id}.cost.cache.read`);
    assert.equal(m.cost.cache.write, 0, `${id}.cost.cache.write`);

    assert.ok(Number.isFinite(m.limit.context) && m.limit.context > 0, `${id}.limit.context=${m.limit.context}`);
    assert.ok(Number.isFinite(m.limit.output) && m.limit.output > 0, `${id}.limit.output=${m.limit.output}`);
    assert.ok(m.limit.output <= m.limit.context, `${id} 的 output 超过 context`);

    assert.deepEqual(Object.keys(m.capabilities).sort(), ["attachment", "input", "interleaved", "output", "reasoning", "temperature", "toolcall"]);
    for (const key of ["temperature", "reasoning", "attachment", "toolcall", "interleaved"]) {
      assert.equal(typeof m.capabilities[key], "boolean", `${id}.capabilities.${key}`);
    }
    assert.deepEqual(Object.keys(m.capabilities.input).sort(), [...MODALITIES].sort(), `${id}.capabilities.input 五模态`);
    assert.deepEqual(Object.keys(m.capabilities.output).sort(), [...MODALITIES].sort(), `${id}.capabilities.output 五模态`);
    for (const key of MODALITIES) {
      assert.equal(typeof m.capabilities.input[key], "boolean", `${id}.capabilities.input.${key}`);
      assert.equal(typeof m.capabilities.output[key], "boolean", `${id}.capabilities.output.${key}`);
    }
    assert.equal(m.capabilities.input.text, true, `${id}.capabilities.input.text`);
    assert.equal(m.capabilities.output.text, true, `${id}.capabilities.output.text`);
    assert.deepEqual(m.modalities.output, ["text"], `${id}.modalities.output`);
  }
});

test("静态表的回退与夹取锚点逐条命中实测值", () => {
  const table = staticModelTable();

  assert.equal(table["qwen-turbo"].limit.output, 8192);
  assert.equal(table["qwen-turbo"].limit.output, DEFAULT_LIMITS.output);
  assert.equal(table["z-ai/glm-4.5-air-free"].limit.context, 131072);
  assert.equal(table["z-ai/glm-4.5-air-free"].limit.context, DEFAULT_LIMITS.context);
  assert.equal(table["meituan/longcat-flash-lite"].limit.output, 256000);
  assert.equal(table["meituan/longcat-flash-lite"].limit.context, 256000);

  assert.ok(table["qwen-vl-max-2025-01-25"].modalities.input.includes("audio"));
  assert.equal(table["qwen-vl-max-2025-01-25"].capabilities.input.audio, true);
  assert.ok(table["z-ai/glm-5.3-flash"].modalities.input.includes("file"));
  assert.equal(table["z-ai/glm-5.3-flash"].capabilities.input.pdf, true);

  assert.equal(Object.values(table).filter((m) => m.modalities.input.includes("audio")).length, 7);
  assert.equal(Object.values(table).filter((m) => m.modalities.input.includes("file")).length, 1);
});

test("activeCount 与表内 status 为 active 的条数严格一致", () => {
  const table = staticModelTable();
  const activeByStatus = Object.values(table).filter((m) => m.status === "active").length;
  assert.equal(activeCount(table), activeByStatus);
  assert.equal(activeCount(table), 87);
  assert.equal(activeCount(staticModelTable({ claudeBypass: true })), 90);
});

test("resolveModelId 解析文档别名、未知 id 原样返回并绕开原型链", () => {
  assert.equal(resolveModelId("GLM-5.3"), "z-ai/glm-5.3");
  assert.equal(resolveModelId("moonshotai/kimi-k2"), "kimi-k2");
  assert.equal(resolveModelId("  GLM-5.3  "), "z-ai/glm-5.3");

  for (const unknown of ["not-a-model", "QWEN/TURBO", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const result = resolveModelId(unknown);
    assert.equal(typeof result, "string", `${unknown} 的解析结果必须是字符串`);
    assert.equal(result, unknown, `${unknown} 未命中时应原样返回`);
  }
});

test("parseLiveModels 吃真实抓包得到 91 条表，字段归一命中目录与上游", () => {
  assert.equal(LIVE.object, "list");
  assert.equal(LIVE.data.length, 91);

  const table = parseLiveModels(LIVE);
  assert.equal(Object.keys(table).length, 91);
  assert.deepEqual(sortedIds(table), LIVE.data.map((item) => item.id).sort());
  assert.equal(activeCount(table), 87);

  for (const raw of LIVE.data) {
    const m = table[raw.id];
    const entry = catalogEntry(raw.id);
    assert.ok(entry, `抓包 id ${raw.id} 应在 CATALOG 里`);

    const expectedContext = raw.context_length > 0 ? raw.context_length : entry.context;
    const rawOutput = raw.max_tokens > 0 ? raw.max_tokens : entry.output || DEFAULT_LIMITS.output;
    const expectedOutput = Math.min(rawOutput, expectedContext);
    const expectedStatus = raw.service_status !== "available" || HIDDEN_IDS.has(raw.id) ? "deprecated" : "active";

    assert.equal(m.id, raw.id);
    assert.equal(m.name, entry.name);
    assert.deepEqual(m.limit, { context: expectedContext, output: expectedOutput }, `${raw.id} 的 limit 归一`);
    assert.equal(m.status, expectedStatus, `${raw.id} 的 status 归一`);
    assert.equal(m.free, entry.free, `${raw.id}.free`);
    assert.equal(m.rate, entry.rate, `${raw.id}.rate`);
    assert.equal(m.reasoning, entry.reasoning, `${raw.id}.reasoning`);
    assert.equal(m.tool_call, entry.toolCall, `${raw.id}.tool_call`);
    assert.equal(m.attachment, entry.vision, `${raw.id}.attachment`);
    assert.equal(m.api.npm, SDK, `${raw.id}.api.npm`);
    assert.equal(m.api.url, CHAT_URL, `${raw.id}.api.url`);
    assert.deepEqual(m.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } }, `${raw.id}.cost`);

    assert.equal(m.capabilities.reasoning, entry.reasoning, `${raw.id}.capabilities.reasoning`);
    assert.equal(m.capabilities.attachment, entry.vision, `${raw.id}.capabilities.attachment`);
    assert.equal(m.capabilities.toolcall, entry.toolCall, `${raw.id}.capabilities.toolcall`);
    assert.equal(m.capabilities.input.image, entry.vision, `${raw.id}.capabilities.input.image`);
    assert.equal(m.capabilities.input.audio, /in:audio/.test(entry.note), `${raw.id}.capabilities.input.audio`);
    assert.equal(m.capabilities.input.pdf, /in:file|in:pdf/.test(entry.note), `${raw.id}.capabilities.input.pdf`);
  }

  assert.equal(table["qwen-turbo"].limit.output, 8192);
  assert.equal(table["z-ai/glm-4.5-air-free"].limit.context, 131072);
  assert.equal(table["meituan/longcat-flash-lite"].limit.output, 256000);
});

test("parseLiveModels 把 unavailable 条目标成 deprecated 并减少 active 数", () => {
  const before = parseLiveModels(LIVE);
  assert.equal(activeCount(before), 87);

  const cloned = cloneLive();
  const victim = cloned.data.find((item) => item.id === "qwen-turbo");
  assert.ok(victim);
  assert.equal(victim.service_status, "available");
  victim.service_status = "unavailable";

  const after = parseLiveModels(cloned);
  assert.equal(after["qwen-turbo"].status, "deprecated");
  assert.equal(after["qwen-turbo"].limit.output, 8192);
  assert.equal(activeCount(after), activeCount(before) - 1);
  assert.equal(activeCount(after), 86);
});

test("parseLiveModels 把 max_tokens 为 0 的条目回退成非零 output", () => {
  const real = parseLiveModels(LIVE);
  assert.equal(findLive("qwen-turbo").max_tokens, 0);
  assert.equal(real["qwen-turbo"].limit.output, 8192);
  assert.ok(real["qwen-turbo"].limit.output > 0);

  const cloned = cloneLive();
  const raw = cloned.data.find((item) => item.id === "doubao-1.5-pro-32k");
  assert.ok(raw);
  raw.max_tokens = 0;

  const table = parseLiveModels(cloned);
  const expected = catalogEntry("doubao-1.5-pro-32k").output;
  assert.ok(expected > 0);
  assert.equal(table["doubao-1.5-pro-32k"].limit.output, expected);
  assert.ok(table["doubao-1.5-pro-32k"].limit.output > 0);
});

test("EXTRA_CATALOG 原厂 Claude 默认缺席，claudeBypass 为真才进静态表", () => {
  const normal = staticModelTable();
  for (const entry of EXTRA_CATALOG) {
    assert.equal(Object.prototype.hasOwnProperty.call(normal, entry.id), false, `${entry.id} 默认不应进表`);
    assert.equal(resolveModelId(entry.id), entry.id);
  }

  const bypass = staticModelTable({ claudeBypass: true });
  assert.equal(Object.keys(bypass).length, 94);
  assert.equal(activeCount(bypass), 90);

  for (const entry of EXTRA_CATALOG) {
    const m = bypass[entry.id];
    assert.ok(m, `${entry.id} 在 claudeBypass 表中`);
    assert.equal(m.api.npm, SDK_ANTHROPIC, `${entry.id}.api.npm`);
    assert.equal(m.api.url, BYPASS_URL, `${entry.id}.api.url`);
    assert.equal(m.headers["anthropic-version"], ANTHROPIC_VERSION);
    assert.equal(m.limit.context, entry.context);
    assert.ok(m.limit.output > 0);
    assert.equal(m.status, "active");
  }
});
