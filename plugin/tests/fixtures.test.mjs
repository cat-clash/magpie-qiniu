// plugin/tests/fixtures.test.mjs — 锁死「CI 用的两套配置 fixture」与 tools/check.mjs 的契约。
//
// 为什么要这份测试：CI 机器上没有 magpie、没有 ~/.config/magpie，所以宿主侧体检只能吃
// tests/fixtures/magpie-ok 与 tests/fixtures/magpie-broken 两套假配置（check 零网络、不读真配置）。
// 这两套 fixture 一旦悄悄被改坏（off 写成 false、spec 少一条、key 换成正经 Key、文件名被改名），
// CI 里的 check 断言就会变成「永远是 0 / 永远是 1」的假绿灯。
// 这里把 fixture 的形状 + tools/check.mjs 读它们的语义一起断言：
//   · 四件套齐全且是合法 JSON
//   · magpie-ok：provider off:false、1 条 spec、账号有 key → 判定层全 ok
//   · magpie-broken：off:true、2 条 spec、账号无 key、proxy=direct → 判定层出 bad/warn
//   · 两套 fixture 的 key 都是明显的假值（sk-FIXTURE 打头），防止有人把真 Key 提交进来
//   · 两套 fixture 的文件名集合完全一致（不然 check 会读到 undefined 而静默降级）
//
// 跑法：node --test plugin/tests/fixtures.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAccounts, checkPluginInstalled, checkProviderSwitched, checkProxy } from "../src/check.mjs";

// plugin/tests/ → 仓库根
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures");
const OK_DIR = join(FIXTURE_ROOT, "magpie-ok");
const BROKEN_DIR = join(FIXTURE_ROOT, "magpie-broken");

/** magpie 配置目录的四件套 —— tools/check.mjs 只读这四个文件。 */
const FIXTURE_FILES = ["plugins.json", "providers.json", "plugin-auth.json", "settings.json"];

const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

const okPlugins = () => readJson(OK_DIR, "plugins.json");
const okProviders = () => readJson(OK_DIR, "providers.json");
const okAuth = () => readJson(OK_DIR, "plugin-auth.json");
const okSettings = () => readJson(OK_DIR, "settings.json");
const brokenPlugins = () => readJson(BROKEN_DIR, "plugins.json");
const brokenProviders = () => readJson(BROKEN_DIR, "providers.json");
const brokenAuth = () => readJson(BROKEN_DIR, "plugin-auth.json");
const brokenSettings = () => readJson(BROKEN_DIR, "settings.json");

/** providers.json 的条目列表，容忍裸数组写法（check 的判定层也容忍）。 */
const asList = (json, key) => (Array.isArray(json) ? json : Array.isArray(json?.[key]) ? json[key] : []);

/** plugins.json 里的 spec 字符串。 */
const specList = (json) =>
  asList(json, "plugins").map((entry) => (typeof entry === "string" ? entry : String(entry?.spec ?? entry?.name ?? "")));

/** plugin-auth.json 里属于 qiniu-ai 的条目（键是 qiniu-ai 或 qiniu-ai@<email>）。 */
const authEntries = (json) =>
  Object.entries(json ?? {}).filter(([k]) => k === "qiniu-ai" || k.startsWith("qiniu-ai@"));

// ── 1. 文件层：四件套齐全且是合法 JSON ───────────────────────────

for (const [label, dir] of [
  ["magpie-ok", OK_DIR],
  ["magpie-broken", BROKEN_DIR],
]) {
  test(`${label}：四件套都存在，且每件都是合法 JSON 对象`, () => {
    for (const name of FIXTURE_FILES) {
      const abs = join(dir, name);
      assert.ok(existsSync(abs), `${label} 缺 ${name}`);
      assert.ok(statSync(abs).isFile(), `${name} 不是普通文件`);
      assert.doesNotThrow(() => readFileSync(abs, "utf8"), `${name} 读不出来`);
      const parsed = JSON.parse(readFileSync(abs, "utf8"));
      assert.equal(typeof parsed, "object", `${name} 顶层不是对象`);
      assert.ok(parsed !== null && !Array.isArray(parsed), `${name} 顶层应为对象而不是数组`);
    }
  });
}

// ── 2. magpie-ok：形状与判定层语义 ──────────────────────────────

test("magpie-ok：providers[0].off === false（provider 是开着的）", () => {
  const providers = asList(okProviders(), "providers");
  assert.equal(providers.length, 1, "ok fixture 只应有 1 个 provider");
  assert.equal(providers[0].id, "qiniu-ai");
  assert.equal(providers[0].off, false);
  assert.equal(checkProviderSwitched(okProviders(), { id: "qiniu-ai" }).level, "ok");
});

test("magpie-ok：plugins.json 只有 1 条 spec，且 check 判定为 ok", () => {
  assert.deepEqual(specList(okPlugins()), ["github:cat-clash/magpie-qiniu"]);
  const c = checkPluginInstalled(okPlugins(), { spec: "qiniu" });
  assert.equal(c.level, "ok", `期望 ok，实际 ${c.level}：${c.detail}`);
});

test("magpie-ok：账号有 key 字段，checkAccounts 判定为 ok", () => {
  const entries = authEntries(okAuth());
  assert.equal(entries.length, 1, "ok fixture 只应有 1 个 qiniu-ai 账号");
  assert.equal(entries[0][1].type, "api");
  assert.ok(String(entries[0][1].key ?? "").trim().length > 0, "ok fixture 的账号必须有 key");
  assert.equal(checkAccounts(okAuth(), { id: "qiniu-ai" }).level, "ok");
});

test("magpie-ok：proxy 是 http://host:port，checkProxy 判定为 ok（不回显完整 URL）", () => {
  assert.match(okSettings().proxy, /^https?:\/\/[^/]+:\d+$/);
  assert.equal(checkProxy(okSettings()).level, "ok");
});

// ── 3. magpie-broken：故意坏掉的四处 ────────────────────────────

test("magpie-broken：providers[0].off === true，check 判定为 bad", () => {
  const providers = asList(brokenProviders(), "providers");
  assert.equal(providers[0].id, "qiniu-ai");
  assert.equal(providers[0].off, true);
  assert.equal(checkProviderSwitched(brokenProviders(), { id: "qiniu-ai" }).level, "bad");
});

test("magpie-broken：plugins.json 有 2 条 spec（重复安装），check 判定为 warn", () => {
  const specs = specList(brokenPlugins());
  assert.equal(specs.length, 2, `期望 2 条 spec，实际 ${specs.length} 条：${specs.join("、")}`);
  assert.ok(specs.includes("github:tk103331/magpie-qiniu-plugin"));
  assert.ok(specs.includes("github:cat-clash/magpie-qiniu"));
  const c = checkPluginInstalled(brokenPlugins(), { spec: "qiniu" });
  assert.equal(c.level, "warn", `期望 warn，实际 ${c.level}：${c.detail}`);
});

test("magpie-broken：账号没有 key 字段（只有 type），check 判定为 bad", () => {
  const entries = authEntries(brokenAuth());
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].type, "api");
  assert.ok(!("key" in entries[0][1]), "坏 fixture 的账号不应有 key 字段");
  assert.equal(checkAccounts(brokenAuth(), { id: "qiniu-ai" }).level, "bad");
});

test('magpie-broken：proxy === "direct"，check 判定为 warn', () => {
  assert.equal(brokenSettings().proxy, "direct");
  assert.equal(checkProxy(brokenSettings()).level, "warn");
});

// ── 4. 假 Key 铁律：任何 fixture 里的 key 都必须以 sk-FIXTURE 打头 ────

test("两套 fixture 里的 key 都是明显的假值（sk-FIXTURE 打头），防真 Key 误提交", () => {
  const seen = [];
  for (const [label, dir] of [
    ["magpie-ok", OK_DIR],
    ["magpie-broken", BROKEN_DIR],
  ]) {
    for (const name of FIXTURE_FILES) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const m of text.matchAll(/"key"\s*:\s*"([^"]*)"/g)) {
        seen.push(`${label}/${name}: ${m[1].slice(0, 12)}…`);
        assert.ok(
          m[1].startsWith("sk-FIXTURE"),
          `${label}/${name} 的 key 必须以 sk-FIXTURE 打头（当前：「${m[1].slice(0, 8)}…」）`,
        );
      }
      // 顺手拦一手：fixture 里不该出现看起来像真 Key 的长串
      assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]{20,}\b/, `${label}/${name} 里出现了疑似真实 Key`);
    }
  }
  assert.ok(seen.length >= 1, "两套 fixture 合计至少要有一个 key 字段被检查到");
});

// ── 5. 两套 fixture 的文件名集合完全一致 ───────────────────────

test("两套 fixture 的文件名集合完全一致（都恰好这四个）", () => {
  const namesOf = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  assert.deepEqual(namesOf(OK_DIR), [...FIXTURE_FILES].sort());
  assert.deepEqual(namesOf(BROKEN_DIR), [...FIXTURE_FILES].sort());
  assert.deepEqual(namesOf(OK_DIR), namesOf(BROKEN_DIR));
});
