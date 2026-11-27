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
//   node tools/doctor.mjs --fix               # 预览 options 自愈计划（dry-run，不写文件）
//   node tools/doctor.mjs --apply             # 真写：先备份 plugins.json 再清脏键/写生效值
//
// 铁律：绝不打印完整 Key / AK / SK；退出码 0 = 全通，1 = 有问题，2 = 用法错误。
//       绝不碰 plugin-auth.json / providers.json / settings.json；绝不停/重启 magpie。

import { copyFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
import { applyPlan, describePlan, isEmptyPlan, planFix } from "../plugin/src/fix.mjs";

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
  --fix                 options 自愈**预览**（dry-run，一个字节都不写）
  --apply               真的写 plugins.json（隐含 --fix；先备份 .bak-doctor-<时间戳>）
  --help, -h            显示本帮助

自愈只动 plugins.json 里 spec 含 qiniu 的那一条的 options：
删除审计里的 legacy / unknown 键，把被夹紧的值写成实际生效值，其余原样保留。

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
const wantApply = argv.includes("--apply");
const wantFix = wantApply || argv.includes("--fix"); // --apply 隐含 --fix
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

// ── 7. options 自愈（--fix 预览 / --apply 真写）──────────────────────────────
// 安全线：只动 plugins.json 里**那一条 qiniu 条目**的 options，其它插件、其它字段原样保留；
// 写前先备份，写失败就把旧内容原样写回去；plugin-auth.json / providers.json / settings.json 一律不碰。
const fixPlan = planFix({ rawOptions, audit, effective });
const fixEmpty = isEmptyPlan(fixPlan);
if (wantFix && wantJson) report.fix = { dryRun: !wantApply, empty: fixEmpty, remove: fixPlan.remove, set: fixPlan.set, keep: fixPlan.keep, reasons: fixPlan.reasons };

/** plugins.json.bak-doctor-<yyyyMMdd-HHmmss>（同目录）。 */
function stampNow() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/** 从原文首行缩进判定缩进；测不出来（单行 JSON 等）就用 2 空格。 */
function detectIndent(text) {
  const m = /\n([ \t]+)["\]}]/.exec(text);
  return m ? m[1] : "  ";
}

/**
 * 备份 → 写 → 失败回滚。返回 { backupPath }。
 * 返回的 root 是 plugins.json 解析后的整棵对象，只在 entry.options 上换内容。
 */
function writeFix() {
  const oldText = readFileSync(pluginsPath, "utf8");
  const bom = oldText.startsWith("\uFEFF") ? "\uFEFF" : "";
  const indent = detectIndent(oldText);
  const trailing = oldText.endsWith("\n") ? "\n" : "";
  const backupPath = `${pluginsPath}.bak-doctor-${stampNow()}`;
  const prevOptions = pluginEntry.options;
  pluginEntry.options = applyPlan(rawOptions, fixPlan);
  const nextText = bom + JSON.stringify(pluginsFile, null, indent) + trailing;
  copyFileSync(pluginsPath, backupPath);
  try {
    writeFileSync(pluginsPath, nextText, "utf8");
  } catch (e) {
    pluginEntry.options = prevOptions;
    let rolled = false;
    try {
      writeFileSync(pluginsPath, oldText, "utf8");
      rolled = true;
    } catch {
      /* 回滚都失败：下面把信息一起打出来，让用户手工拿备份 */
    }
    const err = new Error(String(e?.message || e));
    err.backupPath = backupPath;
    err.rolled = rolled;
    throw err;
  }
  return { backupPath };
}

for (const line of renderReport(report, { json: wantJson })) process.stdout.write(`${line}\n`);
process.exitCode = report.ok ? 0 : 1;

if (wantFix && !wantJson) {
  const out = (s = "") => process.stdout.write(`${s}\n`);
  out("");
  out(wantApply ? "-- options 自愈（--apply，真写） --" : "-- options 自愈（--fix，只预览） --");
  if (fixEmpty) {
    out("[ok] 没有需要修的东西");
    if (!wantApply) out(`  （只读了 ${pluginsPath}，一个字节都没写）`);
  } else if (!wantApply) {
    for (const line of describePlan(fixPlan)) out(`  · ${line}`);
    out("  只预览：一个字节都没写；加 --apply 才会真正写入");
  } else if (!pluginEntry || !existsSync(pluginsPath)) {
    out(`[x] 写不了：plugins.json 里没找到可改的 qiniu 条目（读的是 ${pluginsPath}）`);
    process.exitCode = 1;
  } else {
    try {
      const { backupPath } = writeFix();
      for (const line of describePlan(fixPlan)) out(`  · ${line}`);
      out(`  备份：${backupPath}`);
      out("  重跑 `node tools/doctor.mjs` 验证（-- 配置 -- 应变成 options 全部按预期生效）");
      out("  不用重启 magpie：插件下次加载 options 就生效；要手工还原就 copy 备份覆盖回去");
    } catch (e) {
      out(`[x] 写入失败：${e?.message || e}`);
      if (e?.backupPath) out(`  备份（写前已生成，含原始内容）：${e.backupPath}`);
      out(e?.rolled ? "  已回滚：plugins.json 恢复成写入前的原内容" : `  回滚未能完成，请手工用备份恢复：copy "${e?.backupPath}" "${pluginsPath}"`);
      process.exitCode = 1;
    }
  }
}
