// plugin/tests/doctor.test.mjs — 诊断判定层的单测（node:test，不联网）。
// 覆盖：Key 探测分类、余额/资源包分类、TPD 描述、options 自检、报告渲染。
// 跑法：node --test plugin/tests/doctor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReport,
  classifyBalance,
  classifyKeyProbe,
  classifyTpd,
  LEGACY_OPTIONS,
  optionsAudit,
  renderReport,
} from "../src/doctor.mjs";

// ── Key 探测分类 ─────────────────────────────────────────────

test("classifyKeyProbe：200 = Key 有效", () => {
  const r = classifyKeyProbe({ status: 200 });
  assert.equal(r.level, "ok");
  assert.equal(r.verdict, "Key 有效");
});

test("classifyKeyProbe：401 = Key 废了，给重登提示", () => {
  const r = classifyKeyProbe({ status: 401, code: "auth_api_key_invalid", message: "Invalid API key" });
  assert.equal(r.level, "bad");
  assert.match(r.hint, /plugin login/);
});

test("classifyKeyProbe：403 billing suspended 单独识别成欠费停用", () => {
  const r = classifyKeyProbe({
    status: 403,
    code: "account_billing_suspended",
    message: "Account is suspended due to billing status",
  });
  assert.equal(r.level, "bad");
  assert.match(r.verdict, /欠费/);
  assert.match(r.hint, /充值|资源包/);
});

test("classifyKeyProbe：403 模型组不含目标模型 → warn，不是账号坏", () => {
  const r = classifyKeyProbe({ status: 403, message: "model X is not available in your assigned model groups" });
  assert.equal(r.level, "warn");
  assert.match(r.hint, /模型组/);
});

test("classifyKeyProbe：429 TPD 与 429 RPM 给不同建议", () => {
  const tpd = classifyKeyProbe({ status: 429, message: "UID rate limit reached for TPD (domestic) for UID" });
  assert.equal(tpd.level, "warn");
  assert.match(tpd.verdict, /TPD/);
  assert.match(tpd.hint, /零点/);

  const rpm = classifyKeyProbe({ status: 429, message: "UID rate limit reached for TPM for UID" });
  assert.equal(rpm.level, "warn");
  assert.match(rpm.hint, /pacingMinMs|maxConcurrency/);
});

test("classifyKeyProbe：网络错误（status 0）判 bad 并提示代理", () => {
  const r = classifyKeyProbe({ status: 0, message: "ECONNREFUSED" });
  assert.equal(r.level, "bad");
  assert.match(r.verdict, /连不上/);
});

// ── 余额 / 资源包 ────────────────────────────────────────────

test("classifyBalance：负余额且无资源包 = 阻塞（403 的直接原因）", () => {
  const r = classifyBalance({ available: -1.23 }, undefined);
  assert.equal(r.level, "bad");
  assert.match(r.hint, /充值/);
});

test("classifyBalance：负余额但还有资源包 = 只警告", () => {
  const r = classifyBalance({ available: -1.23 }, { totalRest: 7_010_000, packCount: 3 });
  assert.equal(r.level, "warn");
  assert.match(r.verdict, /资源包/);
});

test("classifyBalance：有待付金额一律阻塞", () => {
  const r = classifyBalance({ available: 10, unpaid: 5 }, { totalRest: 1000, packCount: 1 });
  assert.equal(r.level, "bad");
  assert.match(r.verdict, /待付/);
});

test("classifyBalance：余额 0 且无资源包 = 阻塞；sk- 账号读不到 = 通过", () => {
  assert.equal(classifyBalance({ available: 0 }, undefined).level, "bad");
  assert.equal(classifyBalance(null, undefined).level, "ok");
});

// ── TPD ─────────────────────────────────────────────────────

test("classifyTpd：没有用量时给「今日还没有用量记录」", () => {
  const r = classifyTpd(undefined);
  assert.equal(r.level, "ok");
  assert.match(r.verdict, /还没有用量/);
});

test("classifyTpd：有量时报数量级与模型数", () => {
  const r = classifyTpd({ used: 1_234_567, input: 1_000_000, output: 234_567, cached: 0, models: 2 });
  assert.equal(r.level, "ok");
  assert.match(r.verdict, /今日已用/);
  assert.match(r.verdict, /2 个模型/);
});

// ── options 自检 ────────────────────────────────────────────

test("optionsAudit：识别从未实现的字段（legacy）", () => {
  const a = optionsAudit({ baseUrl: "https://x", dailyUsageDays: 14 }, { providerId: "qiniu-ai" });
  assert.deepEqual(a.legacy.sort(), [...LEGACY_OPTIONS].filter((k) => ["baseUrl", "dailyUsageDays"].includes(k)).sort());
  assert.equal(a.unknown.length, 0);
});

test("optionsAudit：识别不认识的字段与被夹紧的值", () => {
  const a = optionsAudit({ typoOption: 1, breakerThreshold: 999 }, { breakerThreshold: 100 });
  assert.deepEqual(a.unknown, ["typoOption"]);
  assert.deepEqual(a.clamped, [{ key: "breakerThreshold", wrote: 999, effective: 100 }]);
});

test("optionsAudit：全部按预期生效时不报任何东西", () => {
  const a = optionsAudit({ breakerThreshold: 5 }, { breakerThreshold: 5, pacingMinMs: 800 });
  assert.deepEqual(a.unknown, []);
  assert.deepEqual(a.legacy, []);
  assert.deepEqual(a.clamped, []);
});

// ── 报告 ────────────────────────────────────────────────────

const goodAccount = {
  label: "a@example.com",
  checks: [
    { name: "凭据", level: "ok", verdict: "有 sk- Key" },
    { name: "Key 有效性", level: "ok", verdict: "Key 有效" },
    { name: "余额 / 资源包", level: "ok", verdict: "现金 ¥10" },
    { name: "今日 TPD", level: "ok", verdict: "今日还没有用量记录" },
  ],
};

test("buildReport：没有账号时绝不判 ok（装了但没凭据 = 不能用）", () => {
  const r = buildReport({ provider: "qiniu-ai", version: "1.1.0", accounts: [] });
  assert.equal(r.ok, false);
  assert.equal(r.level, "bad");
});

test("buildReport：warn 项进 warns，bad 项进 bads", () => {
  const r = buildReport({
    provider: "qiniu-ai",
    version: "1.1.0",
    accounts: [{ label: "a", checks: [{ name: "余额", level: "bad", verdict: "欠费" }, { name: "TPD", level: "warn", verdict: "接近上限" }] }],
    configWarnings: [{ level: "warn", text: "breakerThreshold=0" }],
  });
  assert.equal(r.level, "bad");
  assert.equal(r.bads.length, 1);
  assert.equal(r.warns.length, 2);
  assert.match(r.bads[0], /a：/);
});

test("renderReport：文本模式给分级标记与修复提示", () => {
  const r = buildReport({ provider: "qiniu-ai", version: "1.1.0", accounts: [goodAccount] });
  const lines = renderReport(r);
  assert.ok(lines[0].includes("=== magpie-qiniu 诊断"));
  assert.ok(lines.some((l) => l.includes("[ok] Key 有效性")));
  assert.ok(lines.some((l) => l.includes("=== 总结 ===")));
  assert.ok(lines.some((l) => l.includes("全通")));
});

test("renderReport：json 模式输出可解析的整份报告", () => {
  const r = buildReport({ provider: "qiniu-ai", version: "1.1.0", accounts: [goodAccount] });
  const [text] = renderReport(r, { json: true });
  const parsed = JSON.parse(text);
  assert.equal(parsed.provider, "qiniu-ai");
  assert.equal(parsed.accounts.length, 1);
});

test("renderReport：阻塞项逐条列出，并带账号前缀", () => {
  const r = buildReport({
    provider: "qiniu-ai",
    version: "1.1.0",
    accounts: [{ label: "b@x.com", checks: [{ name: "余额", level: "bad", verdict: "现金余额 ¥-1.23，且没有可用资源包" }] }],
  });
  const lines = renderReport(r);
  assert.ok(lines.some((l) => l.includes("[x] 1 项阻塞")));
  assert.ok(lines.some((l) => l.includes("b@x.com：现金余额")));
});