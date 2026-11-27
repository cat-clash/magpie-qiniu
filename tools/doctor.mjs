#!/usr/bin/env node
// tools/doctor.mjs — 一条命令回答「这个七牛账号现在到底还能不能用」。
//
// 查七件事，逐条给结论 + 修复建议：
//   1. 有没有凭据（plugin-auth.json 里 provider id 对不对）
//   2. Key 有没有效（带 Bearer 打 GET /v1/models，200 = 有效）
//   3. 余额 / 待付 / 资源包（需要 AK/SK；sk- 账号查不到，属正常）
//   4. 今日 TPD 已用量（429 TPD 命中前唯一的预警指标）
//   5. 模型可用矩阵（--probe-models，默认关：会真的发一次 max_tokens=1 的 chat，产生极小费用）
//   6. options 自检（被夹紧的值、从未实现的字段、拼错的字段）
//   7. 是否被本机熔断/节奏闸影响（给出阈值现状，帮助解释「为什么变慢了」）
//
// 用法：
//   node tools/doctor.mjs                     # 只读探测，不产生 chat 费用
//   node tools/doctor.mjs --probe-models 3    # 顺带探 3 个模型
//   node tools/doctor.mjs --json              # 机器可读
//   node tools/doctor.mjs --auth <path>       # 指定 plugin-auth.json
//
// 铁律：绝不打印完整 Key / AK / SK；退出码 0 = 全通，1 = 有问题，2 = 用法错误。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { QiniuPlugin } from "../plugin/index.mjs";
import { VERSION, INFER_BASE, PROVIDER } from "../plugin/src/config.mjs";
import {
  fetchBalanceOverview,
  fetchRespackList,
  fetchUsageSeries,
  normalizeBalance,
  normalizeUsageSeries,
} from "../plugin/src/usage-api.mjs";
import { readRespack, estimateTpd } from "../plugin/src/usage.mjs";
import { qiniuAuthHeader } from "../plugin/src/sign.mjs";
import { buildReport, classifyBalance, classifyKeyProbe, classifyTpd, optionsAudit, renderReport } from "../plugin/src/doctor.mjs";

// UTF-8 铁律（陷阱 #1）：被 cmd / 计划任务拉起时 print("✓") 会 UnicodeEncodeError
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.reconfigure({ encoding: "utf-8", errors: "replace" });
  } catch {
    /* 老运行时没有 reconfigure，忽略 */
  }
}

const argv = process.argv.slice(2);
const usage = `magpie-qiniu 诊断 ${VERSION}

用法：node tools/doctor.mjs [选项]

  --json                机器可读输出
  --auth <path>         plugin-auth.json 路径（默认 $MAGPIE_CONFIG_DIR 或 ~/.config/magpie）
  --provider <id>       provider id（默认 ${PROVIDER}）
  --probe-models <n>    附带探 n 个模型（默认 0 = 不探，避免产生 chat 费用）
  --models a,b,c        指定要探的模型 id（隐含开启探测）
  --help, -h            显示本帮助

退出码：0 全通 / 1 有问题 / 2 用法错误
`;
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

function argValue(flag, fallback = "") {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  return String(argv[i + 1]);
}

const wantJson = argv.includes("--json");
const provider = argValue("--provider", PROVIDER);
const configDir = process.env.MAGPIE_CONFIG_DIR || join(homedir(), ".config", "magpie");
const authPath = argValue("--auth", join(configDir, "plugin-auth.json"));
const pluginsPath = join(configDir, "plugins.json");
const probeCount = Number(argValue("--probe-models", "0")) || 0;
const modelList = argValue("--models", "").split(",").map((s) => s.trim()).filter(Boolean);
const probeModels = modelList.length ? modelList : probeCount > 0 ? ["deepseek/deepseek-v4-flash", "qwen/qwen3.8-max", "tencent/hy4"].slice(0, Math.max(1, probeCount)) : [];

/** 只保留前 6 后 4，用于给人看的标签（不是日志脱敏，是「本来就只存摘要」）。 */
function maskKey(v) {
  const s = String(v ?? "");
  if (s.length <= 12) return s ? "***" : "";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  }
}

// ── 1. 凭据 ────────────────────────────────────────────────────────────────
const authStore = readJson(authPath) || {};
// 同一个 provider 可能有多条：`qiniu-ai` 或 `qiniu-ai@<email>`（多账号时宿主会加后缀）
const entries = Object.entries(authStore).filter(([k]) => k === provider || k.startsWith(`${provider}@`));

const accounts = [];
for (const [storeKey, raw] of entries) {
  const meta = (raw && typeof raw.metadata === "object" ? raw.metadata : {}) || {};
  const apiKey = String(raw?.key || meta.apiKey || "");
  const accessKey = String(meta.accessKey || "");
  const secretKey = String(meta.secretKey || "");
  const plan = meta.mode === "aksk" ? "按量付费 · AK/SK" : "按量付费 · sk- Key";
  const label = String(meta.email || meta.accountId || meta.alias || storeKey).trim() || storeKey;
  const checks = [];

  if (!apiKey) {
    checks.push({ name: "凭据", level: "bad", verdict: "这条账号没有可用的 sk- Key", hint: "magpie plugin login qiniu-ai 重新登录（AK/SK 账号会自动签发）" });
    accounts.push({ label: `${label}（${plan}）`, checks });
    continue;
  }
  checks.push({ name: "凭据", level: "ok", verdict: `有 sk- Key ${maskKey(apiKey)}（${plan}）` });

  // ── 2. Key 有效性：带 Bearer 打 /v1/models（200 = 有效；401 = 废了） ──────
  try {
    const res = await fetch(`${INFER_BASE}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    const code = String(body?.error?.code || body?.code || "");
    const message = String(body?.error?.message || body?.message || text || "");
    const root = (body?.data ?? body) || {};
    const models = Array.isArray(root?.data) ? root.data : Array.isArray(root) ? root : [];
    const probe = classifyKeyProbe({ status: res.status, code, message });
    checks.push({
      name: "Key 有效性",
      level: probe.level,
      verdict: `${probe.verdict}${res.status === 200 && models.length ? `（上游 ${models.length} 个模型）` : ""}`,
      hint: probe.hint,
    });
  } catch (e) {
    const probe = classifyKeyProbe({ status: 0, message: String(e?.message || e) });
    checks.push({ name: "Key 有效性", level: probe.level, verdict: probe.verdict, hint: probe.hint });
  }

  // ── 3. 余额 / 资源包（AK/SK） ─────────────────────────────────────────────
  if (accessKey && secretKey) {
    let balance;
    let pack;
    try {
      const r = await fetchBalanceOverview({ account: { mode: "aksk", accessKey, secretKey }, sign: qiniuAuthHeader, timeoutMs: 15_000 });
      balance = normalizeBalance(r?.data);
    } catch (e) {
      checks.push({ name: "余额", level: "warn", verdict: `查询失败：${String(e?.message || e).slice(0, 120)}`, hint: "AK/SK 可能填反了（AccessKey 在前）" });
    }
    try {
      const r = await fetchRespackList({ account: { mode: "aksk", accessKey, secretKey }, sign: qiniuAuthHeader, timeoutMs: 15_000 });
      pack = readRespack(r?.data);
    } catch {
      /* 资源包查不到不影响主结论 */
    }
    if (balance) {
      const b = classifyBalance(balance, pack);
      checks.push({ name: "余额 / 资源包", level: b.level, verdict: b.verdict, hint: b.hint });
    }
  } else {
    checks.push({ name: "余额 / 资源包", level: "ok", verdict: "sk- Key 账号没有 AK/SK，查不到余额（用 AK/SK 登录才有）", hint: "" });
  }

  // ── 4. 今日 TPD ───────────────────────────────────────────────────────────
  try {
    const r = await fetchUsageSeries({ account: { mode: "key", apiKey }, sign: qiniuAuthHeader, days: 1, timeoutMs: 15_000 });
    const tpd = estimateTpd(normalizeUsageSeries(r?.data));
    const t = classifyTpd(tpd);
    checks.push({ name: "今日 TPD", level: t.level, verdict: t.verdict, hint: t.hint });
  } catch (e) {
    checks.push({ name: "今日 TPD", level: "warn", verdict: `用量接口失败：${String(e?.message || e).slice(0, 120)}`, hint: "5 req/s 限流或 Key 无权查用量" });
  }

  // ── 5. 模型矩阵（可选） ───────────────────────────────────────────────────
  for (const model of probeModels) {
    try {
      const res = await fetch(`${INFER_BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      const code = String(body?.error?.code || "");
      const message = String(body?.error?.message || text || "");
      if (res.ok) {
        checks.push({ name: `模型 ${model}`, level: "ok", verdict: "可用（200）" });
      } else {
        const probe = classifyKeyProbe({ status: res.status, code, message });
        const short = String(message).replace(/\s+/g, " ").slice(0, 100);
        checks.push({ name: `模型 ${model}`, level: probe.level, verdict: `${res.status} ${code || ""} ${short}`.trim(), hint: probe.hint });
      }
    } catch (e) {
      checks.push({ name: `模型 ${model}`, level: "warn", verdict: `请求失败：${String(e?.message || e).slice(0, 100)}`, hint: "" });
    }
  }

  accounts.push({ label: `${label}（${plan}）`, checks });
}

// ── 6. options 自检 ────────────────────────────────────────────────────────
// plugins.json 的真实形状是 { "plugins": [ { "spec": "...", "options": {...} } ] }。
const pluginsFile = readJson(pluginsPath);
const pluginList = Array.isArray(pluginsFile?.plugins)
  ? pluginsFile.plugins
  : Array.isArray(pluginsFile)
    ? pluginsFile
    : [];
// 同一个插件可能被装成不同 spec（github:xxx / magpie-qiniu-lite / 本地路径），
// 全部收进来，取第一个带 options 的条目做自检，并如实报告匹配到的 spec。
const qiniuEntries = pluginList.filter((p) => /qiniu/i.test(String(p?.spec || p?.name || "")));
const pluginEntry = qiniuEntries.find((p) => p && typeof p === "object" && p.options && Object.keys(p.options).length) || qiniuEntries[0];
const rawOptions = (pluginEntry && pluginEntry.options) || {};
const probe = await QiniuPlugin({}, rawOptions);
const effective = { ...probe.diagnostics.snapshot().options };
const audit = optionsAudit(rawOptions, effective);

const configWarnings = [];
if (audit.legacy.length) configWarnings.push({ level: "warn", text: `options 里有从未实现的字段：${audit.legacy.join(", ")}` });
if (audit.unknown.length) configWarnings.push({ level: "warn", text: `options 里有不认识的字段：${audit.unknown.join(", ")}` });
if (effective.breakerThreshold === 0) configWarnings.push({ level: "warn", text: "breakerThreshold=0：账号级熔断已关闭，撞 TPD/欠费会一直打上游" });
if (effective.pacingMinMs === 0 && effective.pacingJitterMs === 0) configWarnings.push({ level: "warn", text: "pacing 两道都关了：并发容易打穿 RPM/TPM 窗口" });
if (!pluginEntry) configWarnings.push({ level: "warn", text: `plugins.json 里没找到 qiniu 的条目（读的是 ${pluginsPath}）` });
if (pluginEntry && !Object.keys(rawOptions).length) configWarnings.push({ level: "warn", text: `plugins.json 里 ${pluginEntry.spec || "qiniu 插件"} 没有 options，全部用默认值` });

const report = buildReport({ provider, version: VERSION, accounts, options: { ...effective, audit }, configWarnings });
report.authPath = authPath;
report.pluginsPath = pluginsPath;
report.probeModels = probeModels;

for (const line of renderReport(report, { json: wantJson })) process.stdout.write(`${line}\n`);
process.exitCode = report.ok ? 0 : 1;
