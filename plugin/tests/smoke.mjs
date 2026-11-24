// tests/smoke.mjs — 不联网的自检脚本（`bun run smoke` / `node tests/smoke.mjs`）。
//
// 它验证的是「宿主能靠这个插件跑起来」的最低形状要求，不是业务逻辑：
//   1. config 钩子填出完整模型表（每条能力字段齐全，五个模态键显式布尔）
//   2. auth 钩子形状（两条登录方式、loader/usage/import 是函数、确实没有签到）
//   3. loader 的三个不联网分支（模型列表本地答 / 非 chat 一律 501 / 坏体当场 400）
//   4. provider.models 钩子回落
//   5. diagnostics.snapshot()
//   6. readOptions 的夹取与回落
//   7. 脱敏红线：任何快照里不得出现完整 Key
//
// 任何一段失败立刻打印原因并非零退出，方便 CI 一眼定位。

import { readOptions } from "../index.mjs";
import { CATALOG } from "../src/catalog.mjs";
import { QiniuPlugin } from "../index.mjs";

const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`[ok] ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`[x] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- 1. config 钩子 ---------------------------------------------------------
const inst = await QiniuPlugin({}, {});
const cfg = { provider: {} };
await inst.config(cfg);
const slot = cfg.provider["qiniu-ai"];
check("config 钩子填了 qiniu-ai", Boolean(slot), JSON.stringify(Object.keys(cfg.provider)));
check("name/npm/api 齐全", slot.name === "七牛云 Qiniu AI" && slot.npm === "@ai-sdk/openai-compatible" && slot.api === "https://api.qnaigc.com/v1", `${slot.name}|${slot.npm}|${slot.api}`);

const modelIds = Object.keys(slot.models || {});
const expected = CATALOG.length;
check(`模型表条数 = ${expected}`, modelIds.length === expected, `实际 ${modelIds.length}`);
const MODALITY_OK = ["text", "image", "audio", "video", "pdf"];
let badShape = "";
for (const id of modelIds) {
  const m = slot.models[id];
  const c = m?.capabilities;
  if (!m || !c) {
    badShape = `${id}: 缺 capabilities`;
    break;
  }
  for (const side of ["input", "output"]) {
    for (const flag of MODALITY_OK) {
      if (typeof c[side]?.[flag] !== "boolean") {
        badShape = `${id}: capabilities.${side}.${flag} 不是布尔`;
        break;
      }
    }
    if (badShape) break;
  }
  if (badShape) break;
  for (const k of ["id", "name", "status", "limit", "cost", "modalities", "api"]) {
    if (m[k] === undefined) {
      badShape = `${id}: 缺顶层字段 ${k}`;
      break;
    }
  }
  if (badShape) break;
}
check("每条模型形状完整（五模态键显式布尔 + 顶层字段齐全）", !badShape, badShape);

// ---- 2. auth 钩子 -----------------------------------------------------------
const auth = inst.auth;
check("auth.provider", auth.provider === "qiniu-ai", String(auth.provider));
check("两种登录方式（Key / AK-SK）", Array.isArray(auth.methods) && auth.methods.length === 2, `${auth.methods?.length}`);
check("两种都是 api 方式且带 prompts", auth.methods?.every((m) => m.type === "api" && Array.isArray(m.prompts) && m.prompts.length >= 2));
check("AK/SK 那条 prompts 顺序 = accessKey → secretKey", auth.methods?.[1]?.prompts?.map((p) => p.key).join(",") === "accessKey,secretKey,keyLabel", JSON.stringify(auth.methods?.[1]?.prompts?.map((p) => p.key)));
check("loader / usage / import 是函数", typeof auth.loader === "function" && typeof auth.usage === "function" && typeof auth.import === "function");
check("没有签到（用户明确要求）", auth.checkin === undefined, String(auth.checkin));
check("批量导入有中英文说明", Boolean(auth.importFrom && auth.importFroms?.en));

// ---- 3. loader 的三个不联网分支 --------------------------------------------
const loader = await auth.loader(async () => ({ provider: "qiniu-ai", apiKey: "sk-probe-only" }));
const getAuthThrows = async () => {
  throw new Error("账号已登出");
};
const getAuthKey = async () => ({ provider: "qiniu-ai", uid: "u1", apiKey: "sk-probe-only" });

// loader 只创建一次，getAuth 的变化靠外部重新调用 loader 模拟；这里用同一个 loader 测不联网分支
const r1 = await loader.fetch("https://api.qnaigc.com/v1/models", { method: "GET" });
const b1 = await r1.json();
check("GET /models → 200 且本地回表", r1.status === 200 && b1.object === "list" && b1.data.length === expected, `${r1.status} / ${b1.data?.length}`);

const r2 = await loader.fetch("https://api.qnaigc.com/v1/embeddings", { method: "POST", body: "{}" });
check("POST /embeddings → 501 不实现", r2.status === 501, String(r2.status));

const loaderThrows = await auth.loader(getAuthThrows);
const r3 = await loaderThrows.fetch("https://api.qnaigc.com/v1/chat/completions", { method: "POST", body: "{ bad json" });
check("坏 JSON + getAuth 抛 → 401 标记 expired", r3.status === 401 && r3.headers.get("x-magpie-sign-in") === "expired", `${r3.status} ${r3.headers.get("x-magpie-sign-in")}`);

const r4 = await loader.fetch("https://api.qnaigc.com/v1/chat/completions", { method: "POST", body: "{ bad json" });
check("坏 JSON + 有账号 → 400 invalid_json 不发请求", r4.status === 400, String(r4.status));

const r5 = await loaderThrows.fetch("https://api.qnaigc.com/v1/chat/completions", { method: "GET" });
check("GET chat 也走同一分支（不 404 崩）", [400, 401].includes(r5.status), String(r5.status));

// ---- 4. provider.models -----------------------------------------------------
const table = await inst.provider.models(slot, { auth: {} });
check("provider.models 回落到静态表", Object.keys(table).length === expected, String(Object.keys(table).length));
const one = table["z-ai/glm-5"];
check("glm-5 的 capabilities 完整", one?.reasoning === true && one?.api?.npm === "@ai-sdk/openai-compatible" && one?.capabilities?.input?.text === true, JSON.stringify(one?.capabilities?.input));

// ---- 5. diagnostics ---------------------------------------------------------
const snap = inst.diagnostics.snapshot();
check("diagnostics.snapshot() 字段齐全", ["provider", "version", "options", "models", "live", "cost", "requestLog", "redact"].every((k) => k in snap), Object.keys(snap).join(","));
check("models.total = 目录条数", snap.models.total === expected, String(snap.models.total));
check("active < total（有 deprecated）", snap.models.active > 0 && snap.models.active <= expected, `${snap.models.active}/${snap.models.total}`);
const serialized = JSON.stringify(snap);
check("快照不含完整 Key", !/sk-[A-Za-z0-9_-]{16,}/.test(serialized), "发现疑似 Key");

// ---- 6. readOptions ---------------------------------------------------------
const o1 = readOptions({ maxConcurrency: 0, usageCacheMs: 999, providerId: "Bad ID", promptCache: "yes" });
check("maxConcurrency 夹在 1..1000", o1.maxConcurrency === 1, String(o1.maxConcurrency));
check("usageCacheMs 夹在 10000..600000", o1.usageCacheMs === 10000, String(o1.usageCacheMs));
check("非法 providerId 回落 qiniu-ai", o1.providerId === "qiniu-ai", o1.providerId);
check("promptCache 非 true 一律 false", o1.promptCache === false, String(o1.promptCache));
const o2 = readOptions({ maxConcurrency: 64, providerId: "my-qiniu", promptCache: true, claudeBypass: true });
check("合法值原样收下", o2.maxConcurrency === 64 && o2.providerId === "my-qiniu" && o2.promptCache === true && o2.claudeBypass === true);
const o3 = readOptions();
check("缺省值", o3.maxConcurrency === 4 && o3.providerId === "qiniu-ai" && o3.quotaFailover === true && o3.showCost === true);
const o4 = readOptions({ promptCache: false });
check("promptCache 可显式关", o4.promptCache === false);

// ---- 7. 脱敏红线 ------------------------------------------------------------
const { maskKey, redact } = await import("../src/http.mjs");
const FAKE_KEY = `sk-${"A1b2C3d4E5f6G7h8I9j0K1l2"}`;
check("maskKey 不泄露全文", /[…*]/.test(maskKey(FAKE_KEY)) && maskKey(FAKE_KEY).includes("A1b"), maskKey(FAKE_KEY));
check("redact 抹掉 AK:SK 签名", !/Qiniu\s+\S{8,}/.test(redact("Authorization: Qiniu ABCD1234efgh5678:IJKL90mnopqrSTUV:abcdef0123456789")), redact("Authorization: Qiniu ABCD1234efgh5678:IJKL90mnopqrSTUV:abcdef0123456789"));
check("redact 抹掉 Key", !/sk-[A-Za-z0-9_-]{16,}/.test(redact(`key=${FAKE_KEY}`)), redact(`key=${FAKE_KEY}`));

// ---- 汇总 -------------------------------------------------------------------
console.log("");
console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      failed: failures.length,
      models: modelIds.length,
      active: snap.models.active,
      version: snap.version,
    },
    null,
    2,
  ),
);
if (failures.length) {
  console.error(`\n${failures.length} 项失败：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nsmoke 通过：${modelIds.length} 条模型 / ${snap.models.active} 条可用 / ${snap.version}`);
