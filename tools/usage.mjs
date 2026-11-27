#!/usr/bin/env node
// tools/usage.mjs —— 一条命令回答「这个七牛账号近 N 天烧了多少 token、花了多少钱」。
//
// 它只是 CLI 壳：读凭据 → 调 usage-api → 交给 usage-report 排版打印。
// 逻辑都在 plugin/src/usage-report.mjs（纯函数），这里不做任何计算。
//
// 用法：
//   node tools/usage.mjs                       # 近 7 天，按天 + 按模型
//   node tools/usage.mjs --days 30             # 近 30 天（上游按 granularity 再夹一次）
//   node tools/usage.mjs --granularity hour --days 3
//   node tools/usage.mjs --cost                # 顺带查费用
//   node tools/usage.mjs --json                # 机器可读
//
// 铁律：绝不打印 Key / AK / SK（连打码的都不打）；错误一律走上游已脱敏的 message。
//       退出码 0 = 成功，1 = 上游失败，2 = 用法错误。绝不写任何配置文件。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER, VERSION } from "../plugin/src/config.mjs";
import { qiniuAuthHeader } from "../plugin/src/sign.mjs";
import { fetchApiKeyCost, fetchUsageSeries, normalizeCost, normalizeUsageSeries } from "../plugin/src/usage-api.mjs";
import { dailyRows, formatTokens, modelRows, renderTable, summaryLine, tokenTotal } from "../plugin/src/usage-report.mjs";

// UTF-8 铁律（陷阱 #1）：被 cmd / 计划任务拉起时，中文 + "✓" 会 UnicodeEncodeError
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.reconfigure({ encoding: "utf-8", errors: "replace" });
  } catch {
    /* 老运行时没有 reconfigure，忽略 */
  }
}

const argv = process.argv.slice(2);
/** `--flag value` 与 `--flag=value` 都认。 */
function argValue(flag, fallback = "") {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) return i + 1 < argv.length ? String(argv[i + 1]) : fallback;
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return fallback;
}

const usageText = `magpie-qiniu 用量 ${VERSION}

用法：node tools/usage.mjs [选项]

  --days <1..31>         统计天数（默认 7）。granularity=hour 时上游上限 7 天，会被再夹一次
  --granularity day|hour 桶粒度（默认 day）
  --cost                 同时查费用（走 /v3/stat/usage/apikey/cost，5–15 分钟延迟）
  --json                 机器可读输出 { days, granularity, daily, models, total, cost }
  --auth <path>          plugin-auth.json 路径（默认 $MAGPIE_CONFIG_DIR 或 ~/.config/magpie）
  --provider <id>        provider id（默认 ${PROVIDER}）
  --help, -h             显示本帮助

退出码：0 成功 / 1 上游失败 / 2 用法错误
`;

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usageText);
  process.exit(0);
}

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

/** 退出码 2：用法错误。 */
function usageError(message, hint = "") {
  err(`[x] ${message}`);
  if (hint) err(`    ${hint}`);
  err("    node tools/usage.mjs --help 看用法");
  process.exit(2);
}

// ── 参数 ───────────────────────────────────────────────────────────────────
const wantJson = argv.includes("--json");
const wantCost = argv.includes("--cost");
const provider = argValue("--provider", PROVIDER);

const rawGranularity = argValue("--granularity", "day").trim().toLowerCase();
if (rawGranularity !== "day" && rawGranularity !== "hour") {
  usageError(`--granularity 只认 day / hour，收到的是 ${JSON.stringify(rawGranularity)}`);
}
const granularity = rawGranularity;

const rawDays = argValue("--days", "7").trim();
const parsedDays = Number(rawDays);
if (!rawDays || !Number.isInteger(parsedDays)) {
  usageError(`--days 需要一个整数，收到的是 ${JSON.stringify(rawDays)}`);
}
// CLI 层夹紧 1..31；上游还会按 granularity 再夹一次（hour ≤ 7）。
const daysRaw = Math.min(31, Math.max(1, parsedDays));
const granularityCap = granularity === "hour" ? 7 : 31;
const days = Math.min(daysRaw, granularityCap);
const clampNotes = [];
if (daysRaw !== parsedDays) clampNotes.push(`--days ${parsedDays} 已夹紧到 ${daysRaw}（允许范围 1..31）`);
if (days !== daysRaw) clampNotes.push(`--days ${daysRaw} 已夹紧到 ${days}（granularity=${granularity} 的上游上限是 ${granularityCap} 天）`);

// ── 凭据 ───────────────────────────────────────────────────────────────────
const configDir = process.env.MAGPIE_CONFIG_DIR || join(homedir(), ".config", "magpie");
const authPath = argValue("--auth", join(configDir, "plugin-auth.json"));

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  }
}

function failUpstream(message, hints = []) {
  err(`[x] ${message}`);
  for (const h of hints) if (h) err(`    ${h}`);
  process.exit(1);
}

if (!existsSync(authPath)) {
  failUpstream(`找不到凭据文件：${authPath}`, [`先登录一次：magpie plugin login ${provider}`, "或用 --auth <path> 指定 plugin-auth.json"]);
}

let store;
try {
  store = readJson(authPath) || {};
} catch (e) {
  failUpstream(`凭据文件读不出来（不是合法 JSON）：${authPath}`, [String(e?.message || e).slice(0, 160), `登录一次会重写它：magpie plugin login ${provider}`]);
}

// 同一个 provider 可能有多条：`qiniu-ai` 或 `qiniu-ai@<email>`（多账号时宿主加后缀），取第一个。
const entry = Object.entries(store).find(([k]) => k === provider || k.startsWith(`${provider}@`));
if (!entry) {
  failUpstream(`凭据里没有 ${provider} 的条目（读的是 ${authPath}）`, [`先登录一次：magpie plugin login ${provider}`, `或换 --provider <id>`]);
}

const [storeKey, raw] = entry;
const meta = raw && typeof raw.metadata === "object" && raw.metadata ? raw.metadata : {};
const apiKey = String(raw?.key || meta.apiKey || "").trim();
const accessKey = String(meta.accessKey || "").trim();
const secretKey = String(meta.secretKey || "").trim();
const isAksk = Boolean(accessKey && secretKey);
const account = isAksk
  ? { mode: "aksk", accessKey, secretKey, ...(apiKey ? { apiKey } : {}) }
  : { mode: "key", apiKey };
const label = String(meta.alias || meta.email || meta.accountId || storeKey).trim() || storeKey;

if (!isAksk && !apiKey) {
  failUpstream(`${storeKey} 这条没有可用的 sk- Key，也没有 AK/SK`, [`重新登录：magpie plugin login ${provider}`]);
}

// ── 上游失败 → 人话 + 可操作提示（message 已被 usage-api 脱敏）──────────────
function upstreamHints(error) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code || "");
  const base = [`错误代号：${code || `http_${status}`}`];
  if (status === 401) {
    base.unshift("401 = 凭据失效（Key 被删 / 过期 / 换了账号）", `重新登录：magpie plugin login ${provider}`);
  } else if (status === 403) {
    base.unshift("403 = 账号欠费 / 额度用尽 / 无该接口权限", "去七牛控制台充值或领资源包；欠费时用量接口可能只返回空数据");
  } else if (status === 429) {
    base.unshift("429 = 被限流（同 IP 5 req/s 或天级 TPD 到顶）", "等一会儿再跑；别把 --days 拉大反复重试");
    if (error?.retryAfterMs) base.push(`上游建议等待 ${Math.ceil(Number(error.retryAfterMs) / 1000)} 秒`);
  } else if (status === 400) {
    base.unshift("400 = 参数问题（start/end/granularity 格式，或跨度超过该 granularity 的上限）", `用法里 day≤31 天、hour≤7 天；当前请求 ${days} 天 / ${granularity}`);
  } else if (status === 0) {
    base.unshift("没拿到响应（网络 / 代理 / 超时）");
  }
  return base;
}

// ── 拉数据 ─────────────────────────────────────────────────────────────────
let seriesResult;
try {
  seriesResult = await fetchUsageSeries({
    account,
    sign: qiniuAuthHeader,
    days,
    granularity,
    timeoutMs: 20_000,
  });
} catch (e) {
  failUpstream(`用量接口失败：${String(e?.message || e).slice(0, 300)}`, upstreamHints(e));
}

const series = normalizeUsageSeries(seriesResult?.data);
const daily = dailyRows(series);
const models = modelRows(series);
const total = tokenTotal(daily);
const effectiveDays = Number(seriesResult?.days) || days;

let cost = null;
let costNote = "";
if (wantCost) {
  const costType = effectiveDays <= 1 ? "day" : effectiveDays <= 7 ? "week" : "month";
  try {
    const r = await fetchApiKeyCost({ account, sign: qiniuAuthHeader, type: costType, timeoutMs: 20_000 });
    cost = normalizeCost(r?.data);
    costNote = `费用口径：${costType}（上游有 5–15 分钟延迟）`;
  } catch (e) {
    // 费用查不到不该让整条命令失败：用量数据仍然有用。
    err(`[!] 费用查询失败（用量数据照常显示）：${String(e?.message || e).slice(0, 240)}`);
    for (const h of upstreamHints(e)) err(`    ${h}`);
    cost = null;
  }
}

for (const note of clampNotes) err(`[!] ${note}`);

// ── 输出 ───────────────────────────────────────────────────────────────────
if (wantJson) {
  out(
    JSON.stringify(
      {
        days: effectiveDays,
        granularity: String(seriesResult?.granularity || granularity),
        daily,
        models,
        total,
        cost,
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
} else {
  const lines = [];
  lines.push(`七牛云用量 · ${provider} · ${label}（${isAksk ? "AK/SK" : "sk- Key"}）· 近 ${effectiveDays} 天 / ${granularity}`);
  lines.push("");
  lines.push(
    ...renderTable({
      title: "按天",
      headers: ["日期", "输入", "输出", "合计"],
      rows: daily.map((r) => [r.date || "（全部）", formatTokens(r.input), formatTokens(r.output), formatTokens(r.total)]),
      aligns: ["left", "right", "right", "right"],
    }),
  );
  if (!daily.length) lines.push("  上游这段区间没有返回任何 token（欠费 / 未开通 / 期间没调用都长这样）");
  lines.push("");
  lines.push(
    ...renderTable({
      title: "按模型",
      headers: ["模型", "合计", "占比"],
      rows: models.map((r) => [r.model, formatTokens(r.total), `${(r.share * 100).toFixed(1)}%`]),
      aligns: ["left", "right", "right"],
    }),
  );
  if (!models.length) lines.push("  （没有模型维度数据）");
  lines.push("");
  lines.push(summaryLine({ days: effectiveDays, total: total.total, cost: wantCost && cost ? cost.totalFee : null }));
  if (costNote) lines.push(costNote);
  for (const line of lines) out(line);
  process.exitCode = 0;
}
