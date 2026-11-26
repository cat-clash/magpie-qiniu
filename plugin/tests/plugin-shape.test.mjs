// 插件钩子形状测试：只检查 Magpie 契约形状，不发起真实网络请求。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QiniuPlugin, _internal } from "../index.mjs";
import { VERSION } from "../src/config.mjs";

const pluginPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const FAKE_KEY = "sk-" + "A1b2C3d4E5f6G7h8";
const FAKE_AK = "AK" + "0000000000000001";
const FAKE_SK = "SC" + "1111111111111111";

test("插件工厂：只返回 config、auth、provider、diagnostics 四个钩子", async () => {
  const p = await QiniuPlugin();
  assert.deepEqual(Object.keys(p), ["config", "auth", "provider", "diagnostics"]);
  assert.equal(p.checkin, undefined);
  assert.equal(p.refresh, undefined);
  assert.equal(p.auth.checkin, undefined);
  assert.equal(p.auth.refresh, undefined);
});

test("auth 钩子：provider 正确，两种登录方式都是 api 且没有签到", async () => {
  const p = await QiniuPlugin();
  assert.equal(p.auth.provider, "qiniu-ai");
  assert.equal(p.auth.methods.length, 2);
  assert.equal(p.auth.methods.every((m) => m.type === "api"), true);
  assert.equal(p.auth.methods[0].placeholder.includes("sk-"), true);
  assert.equal(p.auth.methods.some((m) => m.type === "checkin"), false);
});

test("auth 钩子：图标、中英文批量导入说明与异步 loader 齐备", async () => {
  const p = await QiniuPlugin();
  assert.equal(p.auth.icon.startsWith("data:image/svg+xml;base64,"), true);
  assert.equal(typeof p.auth.importFrom, "string");
  assert.ok(p.auth.importFrom.length > 0);
  assert.equal(typeof p.auth.importFroms?.en, "string");
  assert.ok(p.auth.importFroms.en.length > 0);
  assert.equal(Object.prototype.toString.call(p.auth.loader), "[object AsyncFunction]");

  const getAuth = async () => ({ provider: "qiniu-ai", key: FAKE_KEY });
  const client = await p.auth.loader(getAuth);
  assert.equal(typeof client, "object");
  assert.equal(typeof client.fetch, "function");
  assert.equal(client.baseURL, "https://api.qnaigc.com/v1");
  assert.equal(client.apiKey, "");
  assert.deepEqual(client.headers, {});
});

test("provider 钩子：id 正确，默认返回 91 条形状完整的模型表", async () => {
  const p = await QiniuPlugin();
  assert.equal(p.provider.id, "qiniu-ai");

  // 源码默认 liveModelList=true，models() 会尝试在线表；用桩断网，强制回落到静态表。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("测试禁止联网");
  };
  let table;
  try {
    table = await p.provider.models({}, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const ids = Object.keys(table);
  assert.equal(ids.length, 91);
  for (const id of ids) {
    const model = table[id];
    assert.equal(model.id, id);
    assert.equal(typeof model.api, "object");
    assert.ok(model.api);
    assert.equal(typeof model.capabilities, "object");
    assert.ok(model.capabilities);
    assert.equal(typeof model.limit, "object");
    assert.ok(model.limit);
    assert.ok(Number.isFinite(model.limit.context) && model.limit.context > 0, id);
    assert.ok(Number.isFinite(model.limit.output) && model.limit.output > 0, id);
  }
});

test("config 钩子：写入 qiniu-ai 槽位并使用 OpenAI 兼容 npm 包", async () => {
  const p = await QiniuPlugin();
  const cfg = { provider: {} };
  await p.config(cfg);

  const slot = cfg.provider["qiniu-ai"];
  assert.ok(slot);
  assert.equal(slot.npm, "@ai-sdk/openai-compatible");
  assert.equal(slot.api.endsWith("/v1"), true);
  const modelIds = Object.keys(slot.models || {});
  assert.ok(modelIds.length > 0);
  for (const id of modelIds) {
    const model = slot.models[id];
    assert.ok(model && model.api && model.capabilities && model.limit, id);
  }
});

test("diagnostics 钩子：快照可序列化且不含完整假凭据", async () => {
  const p = await QiniuPlugin();
  const snap = p.diagnostics.snapshot();
  assert.equal(typeof snap, "object");
  assert.ok(snap);
  const text = JSON.stringify(snap);
  assert.ok(text.length > 0);
  assert.equal(text.includes(FAKE_KEY), false);
  assert.equal(text.includes(FAKE_AK + ":" + FAKE_SK), false);
});

test("_internal 入口：对象存在，版本号与 config.mjs / package.json 三处一致", () => {
  assert.equal(typeof _internal, "object");
  assert.ok(_internal);
  assert.equal(_internal.VERSION, VERSION);
  assert.equal(VERSION, pluginPkg.version, "config.mjs 的 VERSION 必须与 plugin/package.json 同步");
});
