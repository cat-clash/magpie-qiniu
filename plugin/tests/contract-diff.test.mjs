// plugin/tests/contract-diff.test.mjs — scripts/contract-diff.mjs 的纯逻辑单测。
// 全部不联网、不写文件；真实仓库那几条只读 config.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  extractDocKeys,
  extractDefaultsKeys,
  extractReadmeOptionKeys,
  extractContractOptionKeys,
  diffContract,
  exitCodeFor,
} from "../../scripts/contract-diff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

test("extractDefaultsKeys：只抽 DEFAULTS 的一级键，跳过注释、嵌套对象、字符串", () => {
  const source = [
    "// 顶部注释 maxConcurrency: 不该被抓",
    "export const PROVIDER = 'qiniu-ai';",
    "export const DEFAULTS = {",
    "  alphaKey: 1,",
    "  // beta 注释里 fake: true",
    "  betaKey: '字符串里 nestKey: 1',",
    "  nestedObj: {",
    "    deepKey: 2,",
    "  },",
    "  gamma_key: false,",
    "};",
    "export const CLAMP = {",
    "  alphaKey: [1, 1000],",
    "};",
  ].join("\n");

  assert.deepEqual(extractDefaultsKeys(source), ["alphaKey", "betaKey", "gamma_key", "nestedObj"]);
});

test("extractDefaultsKeys：没有 DEFAULTS 时返回空数组", () => {
  assert.deepEqual(extractDefaultsKeys("export const OTHER = { aKey: 1 };\n"), []);
});

test("extractDocKeys：只收反引号里的完整标识符，剔掉 12 / x / URL / 带点带括号的片段", () => {
  const doc = [
    "见 `pacingMinMs` 与 `breakerThreshold`，重复出现 `pacingMinMs`。",
    "噪音：`12`、`x`、`-Force`、`node:crypto`、`https://api.qnaigc.com/v1`、`cfg.provider[q]`。",
    "普通词 foo 不算；`stateDir` 算。",
  ].join(" ");

  assert.deepEqual(extractDocKeys(doc), ["breakerThreshold", "pacingMinMs", "stateDir"]);
});

test("extractReadmeOptionKeys：只留「插件配置」表第一列的键", () => {
  const md = [
    "# 标题",
    "",
    "## 插件配置",
    "",
    "| key | 类型 | 默认 |",
    "|---|---|---|",
    "| `providerId` | string | `qiniu-ai` |",
    "| `webSearch` | string | `auto` |",
    "",
    "## 其它表",
    "",
    "| 变量 | 作用 |",
    "|---|---|",
    "| `MAGPIE_BIN` | 路径 |",
    "| `-Force` | 重装 |",
  ].join("\n");

  assert.deepEqual(extractReadmeOptionKeys(md), ["providerId", "webSearch"]);
});

test("diffContract：三类差集各自命中，legacyKeys 单列不混进 missingInCode", () => {
  const diff = diffContract({
    defaultsKeys: ["alpha", "beta", "gamma"],
    readmeKeys: ["alpha", "delta", "legacyOne"],
    contractKeys: ["alpha", "beta", "delta"],
    legacyKeys: ["legacyOne", "legacyTwo"],
  });

  assert.deepEqual(diff.missingInReadme, ["beta", "gamma"], "代码有、README 没写");
  assert.deepEqual(diff.missingInCode, ["delta"], "README 写了、代码没有；legacyOne 被单列出去");
  assert.deepEqual(diff.missingInContract, ["gamma"], "代码有、契约没提");
  assert.deepEqual(diff.legacyMissingInCode, ["legacyOne", "legacyTwo"], "历史字段单独报");
});

test("exitCodeFor：无差集 0、有差集 2、只有 legacy 仍是 0", () => {
  assert.equal(
    exitCodeFor({ missingInReadme: [], missingInCode: [], missingInContract: [], legacyMissingInCode: [] }),
    0,
  );
  assert.equal(
    exitCodeFor({ missingInReadme: ["webSearch"], missingInCode: [], missingInContract: [] }),
    2,
  );
  assert.equal(
    exitCodeFor({ missingInReadme: [], missingInCode: [], missingInContract: ["keyLabel"] }),
    2,
  );
  assert.equal(
    exitCodeFor({ missingInReadme: [], missingInCode: [], missingInContract: [], legacyMissingInCode: ["baseUrl"] }),
    0,
    "legacy 只报不判错",
  );
});

test("真实仓库：config.mjs 的 DEFAULTS 含 1.1.0 新增键，且不带怪值", () => {
  const keys = extractDefaultsKeys(readFileSync(path.join(REPO, "plugin/src/config.mjs"), "utf8"));

  for (const k of ["pacingMinMs", "breakerThreshold", "breakerCooldownMs", "retryOnNetworkError", "providerId"]) {
    assert.ok(keys.includes(k), `DEFAULTS 应含 ${k}`);
  }
  for (const bad of ["baseUrl", "chatTimeoutMs", "autoCreateKey", "showAllModels", "modelOverrides", "extraHeaders", "dailyUsageDays"]) {
    assert.ok(!keys.includes(bad), `DEFAULTS 不该含历史字段 ${bad}`);
  }
  // CLAMP 里的键不能被当成 DEFAULTS 一级键
  assert.ok(!keys.includes("providerIdPrefix"), "不该抽到 CLAMP 的键");
  assert.ok(!keys.includes("deepKey"), "不该抽到嵌套键");
});

test("真实仓库：三份文件跑一遍，差集是排序去重的字符串数组", () => {
  const contractText = readFileSync(path.join(REPO, "CONTRACT.md"), "utf8");
  const readmeText = readFileSync(path.join(REPO, "README.md"), "utf8");
  const configText = readFileSync(path.join(REPO, "plugin/src/config.mjs"), "utf8");

  const defaultsKeys = extractDefaultsKeys(configText);
  const readmeKeys = extractReadmeOptionKeys(readmeText);
  const contractKeys = extractDocKeys(contractText);
  const legacyKeys = extractContractOptionKeys(contractText).filter((k) => !defaultsKeys.includes(k));

  const diff = diffContract({ defaultsKeys, readmeKeys, contractKeys, legacyKeys });

  for (const list of [diff.missingInReadme, diff.missingInCode, diff.missingInContract, diff.legacyMissingInCode]) {
    assert.ok(Array.isArray(list));
    assert.deepEqual(list, [...new Set(list)].sort(), "必须去重并排序");
  }
  assert.ok(defaultsKeys.length >= 19, `真实 DEFAULTS 至少 19 个键，实际 ${defaultsKeys.length}`);
  assert.ok(readmeKeys.length > 0, "README「插件配置」表必须能被抽到");
  // legacy 的推导能力用夹具证明（真实 CONTRACT 的历史字段会被逐步清掉，不该拿来当断言石）
  const fixture = "## 4. options\n\n| `baseUrl` | string | x |\n| `retryOnNetworkError` | bool | y |\n";
  const fixtureLegacy = extractContractOptionKeys(fixture).filter((k) => !defaultsKeys.includes(k));
  assert.deepEqual(fixtureLegacy, ["baseUrl"], "只在契约里出现的键应被判成 legacy");
  assert.ok(legacyKeys.every((k) => !defaultsKeys.includes(k)), "legacy 与代码键不能重叠");
});
