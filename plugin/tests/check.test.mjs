// plugin/tests/check.test.mjs — 宿主侧体检判定层的单测（node:test，不联网、不读真实配置）。
// 覆盖：Node 版本 / 仓库完整性 / 插件安装 / provider 开关 / 账号 / 代理 / magpie 二进制 /
//      summarize 的 bad>warn>ok 优先级 / renderChecks 的符号与 --json 模式 / makeCheck 默认值 /
//      planRepair 的自愈计划（provider on、多余的 plugin rm、判断不出就不动）与人工项。
// 跑法：node --test plugin/tests/check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_LEVELS,
  checkAccounts,
  checkMagpieBinary,
  checkNode,
  checkPluginInstalled,
  checkProviderSwitched,
  checkProxy,
  checkRepoFiles,
  describeManual,
  describeRepair,
  isEmptyRepair,
  makeCheck,
  maskProxy,
  planRepair,
  renderChecks,
  summarize,
} from "../src/check.mjs";

const ALL_FILES = ["plugin/index.mjs", "plugin/src/config.mjs", "index.mjs", "package.json", "install.ps1", "install.sh"];

// ── makeCheck ────────────────────────────────────────────────

test("makeCheck：detail/hint 缺省是空串，字段齐全", () => {
  const c = makeCheck({ id: "x", level: "ok", label: "标签" });
  assert.deepEqual(c, { id: "x", level: "ok", label: "标签", detail: "", hint: "" });
  assert.ok(CHECK_LEVELS.includes(c.level));
});

test("makeCheck：非法 level 退化成 info，不抛错", () => {
  const c = makeCheck({ id: "x", level: "爆炸", label: "标签" });
  assert.equal(c.level, "info");
  assert.equal(makeCheck({ level: "warn", label: "只有 level" }).id, "");
});

// ── checkNode ────────────────────────────────────────────────

test("checkNode：22.14.0 判 ok", () => {
  const c = checkNode("22.14.0");
  assert.equal(c.level, "ok");
  assert.match(c.detail, /22/);
});

test("checkNode：20.x 判 bad 并提示换 Node 22+", () => {
  const c = checkNode("20.11.1");
  assert.equal(c.level, "bad");
  assert.match(c.detail, /20\.11\.1/);
  assert.match(c.hint, /22/);
});

test("checkNode：版本号解析不了判 warn", () => {
  assert.equal(checkNode("не-版本").level, "warn");
  assert.equal(checkNode(undefined).level, "warn");
  assert.equal(checkNode("v22").level, "ok");
});

// ── checkRepoFiles ───────────────────────────────────────────

test("checkRepoFiles：关键文件齐全判 ok", () => {
  const c = checkRepoFiles(ALL_FILES);
  assert.equal(c.level, "ok");
  assert.match(c.detail, /4 个关键文件齐全/);
});

test("checkRepoFiles：缺 plugin/src/config.mjs 判 bad", () => {
  const c = checkRepoFiles(ALL_FILES.filter((f) => f !== "plugin/src/config.mjs"));
  assert.equal(c.level, "bad");
  assert.match(c.detail, /plugin\/src\/config\.mjs/);
});

test("checkRepoFiles：只缺 install 脚本判 warn（反斜杠也能认）", () => {
  const have = ["plugin\\index.mjs", ".\\plugin/src/config.mjs", "index.mjs", "package.json"];
  const c = checkRepoFiles(have);
  assert.equal(c.level, "warn");
  assert.match(c.detail, /install\.ps1/);
  assert.deepEqual(checkRepoFiles([]).level, "bad");
});

// ── checkPluginInstalled ─────────────────────────────────────

test("checkPluginInstalled：找到一条 qiniu 判 ok", () => {
  const json = { plugins: [{ spec: "github:cat-clash/magpie-qiniu" }, { spec: "magpie-workbuddy@latest" }] };
  const c = checkPluginInstalled(json);
  assert.equal(c.level, "ok");
  assert.match(c.detail, /magpie-qiniu/);
});

test("checkPluginInstalled：一条都没有判 bad", () => {
  const c = checkPluginInstalled({ plugins: [{ spec: "magpie-workbuddy@latest" }] }, { source: "plugins.json" });
  assert.equal(c.level, "bad");
  assert.match(c.hint, /plugin add/);
  assert.match(c.detail, /plugins\.json/);
  assert.equal(checkPluginInstalled(undefined).level, "bad");
});

test("checkPluginInstalled：装了两份判 warn（宿主只认一份）", () => {
  const json = { plugins: [{ spec: "github:tk103331/magpie-qiniu-plugin" }, { spec: "github:cat-clash/magpie-qiniu" }] };
  const c = checkPluginInstalled(json);
  assert.equal(c.level, "warn");
  assert.match(c.detail, /找到 2 条/);
});

// ── checkProviderSwitched ────────────────────────────────────

test("checkProviderSwitched：off:true 判 bad（plugin off/on 的坑）", () => {
  const c = checkProviderSwitched({ providers: [{ id: "qiniu-ai", off: true }] });
  assert.equal(c.level, "bad");
  assert.match(c.hint, /provider on qiniu-ai/);
});

test("checkProviderSwitched：off 缺省或 false 判 ok，找不到 provider 判 bad", () => {
  assert.equal(checkProviderSwitched({ providers: [{ id: "qiniu-ai" }] }).level, "ok");
  assert.equal(checkProviderSwitched({ providers: [{ id: "qiniu-ai", off: false }] }).level, "ok");
  const missing = checkProviderSwitched({ providers: [{ id: "qiniu", off: false }] });
  assert.equal(missing.level, "bad");
  assert.match(missing.detail, /qiniu-ai/);
});

// ── checkAccounts ────────────────────────────────────────────

test("checkAccounts：没有账号判 bad", () => {
  const c = checkAccounts({ "some-other": { key: "sk-x" } });
  assert.equal(c.level, "bad");
  assert.match(c.hint, /plugin login/);
});

test("checkAccounts：有账号但都没 key 判 bad（AK/SK 没签发）", () => {
  const c = checkAccounts({
    "qiniu-ai": { metadata: { mode: "aksk", accessKey: "AK", secretKey: "SK" } },
    "qiniu-ai@a@b.com": { metadata: { mode: "aksk" } },
  });
  assert.equal(c.level, "bad");
  assert.match(c.detail, /2 个账号/);
});

test("checkAccounts：≥1 个有 key 判 ok，且 detail 里不出现 key 原文", () => {
  const c = checkAccounts({
    "qiniu-ai": { key: "sk-verysecret123456" },
    "qiniu-ai@a@b.com": { metadata: { mode: "aksk" } },
  });
  assert.equal(c.level, "ok");
  assert.match(c.detail, /2 个账号，其中 1 个有 sk- Key/);
  assert.doesNotMatch(JSON.stringify(c), /verysecret/);
});

// ── checkProxy ───────────────────────────────────────────────

test("checkProxy：http 代理判 ok 且只回显 host:port（脱敏）", () => {
  const c = checkProxy({ proxy: "http://user:pass-word@127.0.0.1:7897/some/path" });
  assert.equal(c.level, "ok");
  assert.equal(c.detail, "127.0.0.1:7897");
  assert.doesNotMatch(JSON.stringify(c), /pass-word/);
});

test("checkProxy：direct 判 warn 并说清七牛国内直连没问题", () => {
  const c = checkProxy({ proxy: "direct" });
  assert.equal(c.level, "warn");
  assert.match(c.detail, /direct/);
  assert.match(c.hint, /七牛/);
});

test("checkProxy：缺失判 info，不认识的写法判 warn", () => {
  assert.equal(checkProxy({}).level, "info");
  assert.equal(checkProxy(undefined).level, "info");
  assert.equal(checkProxy({ proxy: "" }).level, "info");
  assert.equal(checkProxy({ proxy: "socks5://10.0.0.2:1080" }).level, "warn");
  assert.equal(maskProxy("https://127.0.0.1"), "127.0.0.1:443");
});

// ── checkMagpieBinary ────────────────────────────────────────

test("checkMagpieBinary：给到路径判 ok，没找到判 warn", () => {
  const ok = checkMagpieBinary("D:\\magpie\\magpie.com");
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, /magpie\.com/);
  assert.equal(checkMagpieBinary({ path: "/usr/local/bin/magpie" }).level, "ok");

  const miss = checkMagpieBinary("");
  assert.equal(miss.level, "warn");
  assert.match(miss.hint, /MAGPIE_BIN/);
  assert.match(checkMagpieBinary({ path: "", note: "MAGPIE_BIN 指向的 X 不存在" }).detail, /不存在/);
});

// ── summarize ────────────────────────────────────────────────

test("summarize：bad 压过 warn，warn 压过 ok，info 不参与定级", () => {
  const okOnly = summarize([
    makeCheck({ id: "a", level: "ok", label: "A", detail: "好" }),
    makeCheck({ id: "b", level: "info", label: "B" }),
  ]);
  assert.equal(okOnly.level, "ok");
  assert.equal(okOnly.ok, true);
  assert.deepEqual(okOnly.bads, []);
  assert.deepEqual(okOnly.warns, []);

  const oneWarn = summarize([
    makeCheck({ id: "a", level: "ok", label: "A" }),
    makeCheck({ id: "b", level: "warn", label: "B", detail: "不好" }),
  ]);
  assert.equal(oneWarn.level, "warn");
  assert.equal(oneWarn.ok, false);
  assert.deepEqual(oneWarn.warns, ["B：不好"]);

  const withBad = summarize([
    makeCheck({ id: "b", level: "warn", label: "B" }),
    makeCheck({ id: "c", level: "bad", label: "C", detail: "坏了" }),
  ]);
  assert.equal(withBad.level, "bad");
  assert.deepEqual(withBad.bads, ["C：坏了"]);
  assert.equal(withBad.checks.length, 2);

  assert.equal(summarize([]).level, "ok");
  assert.equal(summarize(undefined).level, "ok");
});

// ── renderChecks ─────────────────────────────────────────────

test("renderChecks：符号前缀 + 两格缩进的修复行", () => {
  const result = summarize([
    makeCheck({ id: "a", level: "ok", label: "Node 版本", detail: "v22.14.0 ≥ 22" }),
    makeCheck({ id: "b", level: "bad", label: "provider 开关", detail: "off:true", hint: "magpie provider on qiniu-ai" }),
    makeCheck({ id: "c", level: "info", label: "代理", detail: "无" }),
  ]);
  const lines = renderChecks(result);
  assert.deepEqual(lines, [
    "✓ Node 版本：v22.14.0 ≥ 22",
    "✗ provider 开关：off:true",
    "  → 修复：magpie provider on qiniu-ai",
    "ℹ 代理：无",
  ]);
  assert.ok(!lines.some((l) => /\[ok\]|\[x\]/.test(l)));
});

test("renderChecks：--json 只输出一行可解析的 JSON", () => {
  const result = summarize([makeCheck({ id: "a", level: "warn", label: "A" })]);
  const lines = renderChecks(result, { json: true });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.checks[0].label, "A");
});

test("renderChecks：color 模式带 ANSI，纯文本模式不带", () => {
  const result = summarize([makeCheck({ id: "a", level: "bad", label: "A" })]);
  assert.match(renderChecks(result, { color: true })[0], /\x1b\[31m✗\x1b\[0m/);
  assert.doesNotMatch(renderChecks(result)[0], /\x1b\[/);
  assert.deepEqual(renderChecks({ checks: [] }), []);
});

// ── planRepair / describeRepair / isEmptyRepair（--fix / --apply 的计划层） ──────

/** 全绿现场：7 条检查全是 ok/info。 */
function allGreenChecks() {
  return [
    checkNode("22.14.0"),
    checkRepoFiles(ALL_FILES),
    checkPluginInstalled({ plugins: [{ spec: "github:cat-clash/magpie-qiniu" }] }),
    checkProviderSwitched({ providers: [{ id: "qiniu-ai" }] }),
    checkAccounts({ "qiniu-ai": { key: "sk-verysecret123456" } }),
    checkProxy({ proxy: "http://127.0.0.1:7897" }),
    checkMagpieBinary("D:\\magpie\\magpie.com"),
  ];
}

test("planRepair：provider 被置 off → 恰好一条 provider-on，args 正确", () => {
  const checks = [checkProviderSwitched({ providers: [{ id: "qiniu-ai", off: true }] })];
  const plan = planRepair({ checks });
  assert.equal(plan.empty, false);
  assert.equal(isEmptyRepair(plan), false);
  assert.equal(plan.actions.length, 1);
  const a = plan.actions[0];
  assert.equal(a.kind, "provider-on");
  assert.equal(a.command, "magpie");
  assert.deepEqual(a.args, ["provider", "on", "qiniu-ai"]);
  assert.match(a.why, /off/);
  assert.equal(plan.manual.length, 0);
});

test("planRepair：重复 spec → 保留 cat-clash 那条，另一条生成 plugin-rm", () => {
  const dup = checkPluginInstalled({
    plugins: [{ spec: "github:tk103331/magpie-qiniu-plugin" }, { spec: "github:cat-clash/magpie-qiniu" }],
  });
  assert.equal(dup.level, "warn");
  const plan = planRepair({ checks: [dup] });
  assert.equal(plan.actions.length, 1);
  const a = plan.actions[0];
  assert.equal(a.kind, "plugin-rm");
  assert.deepEqual(a.args, ["plugin", "rm", "github:tk103331/magpie-qiniu-plugin"]);
  // 官方那条绝不能被移除
  assert.ok(!plan.actions.some((x) => x.args.includes("github:cat-clash/magpie-qiniu")));
});

test("planRepair：判断不出保留谁时不产生任何 rm 动作", () => {
  // 两条都含 cat-clash/magpie-qiniu（一个带 tag）→ 分不清真身，宁可不动
  const twoOfficial = checkPluginInstalled({
    plugins: [{ spec: "github:cat-clash/magpie-qiniu@1.2.3" }, { spec: "github:cat-clash/magpie-qiniu" }],
  });
  const p1 = planRepair({ checks: [twoOfficial] });
  assert.deepEqual(p1.actions, []);
  assert.equal(p1.empty, true);
  assert.equal(p1.manual.length, 1);
  assert.match(p1.manual[0], /判断不出/);

  // detail 解析不出 spec 列表（外部手搓的 check）→ 同样不动
  const opaque = makeCheck({ id: "plugin-installed", level: "warn", label: "插件安装", detail: "装重了" });
  assert.deepEqual(planRepair({ checks: [opaque] }).actions, []);
});

test("planRepair：全绿现场 → empty 为 true，没有动作也没有人工项", () => {
  const plan = planRepair({ checks: allGreenChecks() });
  assert.equal(plan.empty, true);
  assert.equal(isEmptyRepair(plan), true);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.manual, []);
  assert.deepEqual(describeRepair(plan), []);
  assert.deepEqual(describeManual(plan), []);
});

test("describeRepair：每类动作都有可读文案且含完整命令", () => {
  const checks = [
    checkPluginInstalled({
      plugins: [{ spec: "github:tk103331/magpie-qiniu-plugin" }, { spec: "github:cat-clash/magpie-qiniu" }],
    }),
    checkProviderSwitched({ providers: [{ id: "qiniu-ai", off: true }] }),
  ];
  const plan = planRepair({ checks });
  assert.equal(plan.actions.length, 2);
  const lines = describeRepair(plan);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /magpie /);
  assert.ok(lines.some((l) => l.includes("magpie provider on qiniu-ai")));
  assert.ok(lines.some((l) => l.includes("magpie plugin rm github:tk103331/magpie-qiniu-plugin")));
  // plugin-rm 一定排在 provider-on 前面（rm 可能把 provider 置 off，on 要放最后）
  assert.ok(lines[0].includes("plugin rm"));
  assert.ok(lines[1].includes("provider on"));
  // 未知 kind（手搓 plan）也不抛，退化成 why + 命令
  assert.deepEqual(describeRepair({ actions: null }), []);
  assert.equal(describeRepair(undefined).length, 0);
});

test("planRepair：账号为空 / Key 缺失 / 仓库缺失都不产生任何 action（只进人工项）", () => {
  const checks = [
    checkAccounts({ "some-other": { key: "sk-verysecret123456" } }),
    checkAccounts({ "qiniu-ai": { metadata: { mode: "aksk" } } }),
    checkRepoFiles(ALL_FILES.filter((f) => f !== "plugin/src/config.mjs")),
    checkNode("20.11.1"),
    checkProxy({ proxy: "direct" }),
  ];
  const plan = planRepair({ checks });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.empty, true);
  assert.equal(isEmptyRepair(plan), true);
  assert.equal(plan.manual.length, 5);
  assert.ok(plan.manual.every((l) => /要人工处理/.test(l)));
  assert.ok(plan.manual.some((l) => l.includes("账号")));
  assert.ok(plan.manual.some((l) => l.includes("仓库完整性")));
  // 人工项里绝不夹带 Key 原文
  assert.doesNotMatch(JSON.stringify(plan), /verysecret/);
});

test("planRepair：checks 为空数组 / undefined / 怪形状都不抛，且判为空计划", () => {
  for (const input of [undefined, {}, { checks: undefined }, { checks: null }, { checks: [] }, { checks: [null, 1, "x"] }]) {
    const plan = planRepair(input);
    assert.equal(plan.empty, true);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.manual, []);
    assert.equal(isEmptyRepair(plan), true);
  }
  assert.deepEqual(describeRepair(null), []);
  assert.equal(isEmptyRepair(undefined), true);
});

test("renderChecks：输出与自愈计划无耦合（旧 7 项格式一个字都没变）", () => {
  const checks = [
    checkNode("22.14.0"),
    checkProviderSwitched({ providers: [{ id: "qiniu-ai", off: true }] }),
  ];
  const result = summarize(checks);
  const lines = renderChecks(result);
  assert.deepEqual(lines, [
    "✓ Node 版本：v22.14.0 ≥ 22",
    "✗ provider 开关：qiniu-ai 是 off:true（模型选不到它，请求直接 404）",
    "  → 修复：magpie provider on qiniu-ai 打开；plugin off/on 之后要重新开一次",
  ]);
  // 先有计划、再渲染，渲染结果必须一模一样（计划层不改 checks，也不往里塞字段）
  const before = JSON.stringify(lines);
  planRepair({ checks });
  assert.equal(JSON.stringify(renderChecks(result)), before);
  assert.deepEqual(Object.keys(checks[1]).sort(), ["detail", "hint", "id", "label", "level"]);
  // --json 也只有一个对象，不夹带 repair 字段（那是 CLI 自己加的）
  assert.equal(JSON.parse(renderChecks(result, { json: true })[0]).repair, undefined);
});
