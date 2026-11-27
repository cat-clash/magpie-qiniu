#!/usr/bin/env node
// tools/score.mjs — 91 个七牛模型「我该用哪个」的一条命令答案。纯读：不联网、不写文件。
//
// 用法：
//   node tools/score.mjs                        # balanced 前 10
//   node tools/score.mjs --profile coding       # 编码榜
//   node tools/score.mjs --profile cheap --all  # 省钱的完整排序
//   node tools/score.mjs --profile vision --json
//   node tools/score.mjs --exclude a,b,c        # 手动排除（例如已知 503 的模型）
//   node tools/score.mjs --dead-from ~/.cache/magpie/model-health.json   # 按插件落盘的 dead 结论排除
//
// 关于健康态：health.mjs 的 dead 结论默认只活在宿主进程内存里，CLI 读不到 —— 所以**默认不排除任何
// 模型**。两条路可以按实测结果剔掉几条：--exclude 手动传，或 --dead-from 指向插件写出的
// `<stateDir>/model-health.json`（插件在集成方给了 stateDir 时才会写这个文件）。
// --include-dead 因此是个显式的空操作（语义：我不排除任何东西），留着是为了脚本里能对称地写。
//
// 退出码：0 成功 / 2 未知 profile 或用法错误。--dead-from 读不到只提示、不改退出码。

import { readFileSync } from "node:fs";
import { CATALOG, DEFAULT_LIMITS as CATALOG_LIMITS, UPSTREAM_FACTS } from "../plugin/src/catalog.mjs";
import {
  DEFAULT_LIMITS,
  PROFILES,
  PROFILE_HINTS,
  PROFILE_WEIGHTS,
  compareProfiles,
  explain,
  rankModels,
} from "../plugin/src/score.mjs";

// 中文/全角按 2 列算，否则表格在等宽字体里会错位（本文件只输出 ASCII + 中文标签）。
function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function pad(s, n) {
  const t = String(s);
  const gap = n - width(t);
  return gap > 0 ? t + " ".repeat(gap) : t;
}

const USAGE = `模型评分与推荐 · 七牛 AI 推理（${UPSTREAM_FACTS.TOTAL} 个模型，${UPSTREAM_FACTS.FETCHED_AT} 实测目录）

用法：node tools/score.mjs [选项]

  --profile <name>   用途档位：${PROFILES.join(" | ")}（默认 balanced）
  --limit <n>        显示前 n 名（默认 10；--all 覆盖它）
  --all              列出全部模型
  --json             机器可读输出（含各维度分与兜底留痕）
  --exclude a,b,c    手动排除模型 id（默认不排除任何模型，见文件头「关于健康态」）
  --dead-from <file> 读插件写出的健康态文件，把里面判死的模型并入排除
                     （文件由插件在设置了 stateDir 后写出，路径 <stateDir>/model-health.json；
                      读不到 / 坏 JSON 只提示一行，按未排除处理，退出码仍是 0）
  --include-dead     显式声明「不排除任何模型」（空操作，默认即是）
  --help, -h         显示本帮助

说明：分数是 0..1，四个维度 context / output / price / capability 按 profile 加权求和。
      数据脏值（context 或 output 为 0 / 缺失）按 ${DEFAULT_LIMITS.context} / ${DEFAULT_LIMITS.output} 兜底，
      JSON 输出的 parts.notes 会写明哪一条兜了底。

退出码：0 成功 / 2 未知 profile 或用法错误
`;

const argv = process.argv.slice(2);

function argValue(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  if (i + 1 >= argv.length) return "";
  const next = argv[i + 1];
  return next.startsWith("--") ? "" : next;
}

function fail(msg) {
  process.stderr.write(`score: ${msg}\n`);
  process.stderr.write(`用法：node tools/score.mjs [--profile ${PROFILES.join("|")}] [--limit n] [--all] [--json] [--exclude a,b] [--dead-from file] [--help]\n`);
  process.exit(2);
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// 未知参数一律 2：宁可报错，也不要让人以为筛选条件生效了。
const KNOWN = new Set([
  "--profile",
  "--limit",
  "--json",
  "--all",
  "--exclude",
  "--dead-from",
  "--include-dead",
  "--help",
  "-h",
]);
for (const a of argv) {
  if (a.startsWith("--") && !KNOWN.has(a)) fail(`不认识的参数 ${a}`);
}

const profile = argValue("--profile") || "balanced";
if (!PROFILES.includes(profile)) fail(`未知 profile「${profile}」，可选：${PROFILES.join(" / ")}`);

const wantJson = argv.includes("--json");
const wantAll = argv.includes("--all");
// --include-dead 是显式空操作：默认就不排除任何模型（健康态在宿主进程内存里，CLI 读不到）。
const explicitNoFilter = argv.includes("--include-dead");

let limit = 10;
if (argValue("--limit") !== undefined) {
  const raw = argValue("--limit");
  if (raw === "") fail("--limit 需要一个正整数");
  limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) fail(`--limit 需要正整数，收到「${raw}」`);
}
if (wantAll) limit = CATALOG.length;

// --exclude：用户手写的那一份（JSON 里的 excludedUnknown 只看这一份，避免把状态文件里的历史 id 当噪音）。
const flagExclude = (argValue("--exclude") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 从健康态文件里抽出「判死」的模型 id。两种形状都认：
 *   1) 插件落盘形状 { version: 1, savedAt, entries: { [id]: { failures, deadAtMs, lastStatus, lastCode } } }
 *   2) 简化形状     { dead: ["id-a", "id-b"] }（也顺手认裸数组）
 * TTL 由插件侧自己清理，CLI 只做「文件里写着 dead 就排除」，不猜时效。
 *
 * @param {unknown} parsed JSON.parse 的结果
 * @returns {string[]} 判死的模型 id（去重、保序）
 */
function deadIdsFrom(parsed) {
  const out = new Set();
  const push = (v) => {
    if (typeof v !== "string") return;
    const id = v.trim();
    if (id) out.add(id);
  };

  if (Array.isArray(parsed)) {
    for (const v of parsed) push(v);
    return [...out];
  }
  if (!parsed || typeof parsed !== "object") return [];

  if (Array.isArray(parsed.dead)) for (const v of parsed.dead) push(v);

  const entries = parsed.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [id, e] of Object.entries(entries)) {
      if (!e || typeof e !== "object") continue;
      const deadAtMs = Number(e.deadAtMs);
      if ((Number.isFinite(deadAtMs) && deadAtMs > 0) || e.dead === true) push(id);
    }
  }
  return [...out];
}

const deadFrom = argValue("--dead-from");
let deadFromUsed = false;
let deadExclude = [];

// 提示走哪个流：--json 时绝不能污染 stdout（那是给脚本 JSON.parse 的），改走 stderr。
const notice = (msg) => (wantJson ? process.stderr : process.stdout).write(`${msg}\n`);

if (deadFrom !== undefined) {
  // 空值（`--dead-from` 后面没跟路径）当读不到处理，不报错退出。
  if (!deadFrom) {
    notice("ℹ 读不到 ，按未排除处理");
  } else {
    let text;
    let ok = false;
    try {
      text = readFileSync(deadFrom, "utf8");
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) {
      try {
        // 手写/被 Windows 编辑器存过 BOM 的文件也要认：先剥 BOM 再 parse。
        const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        deadExclude = deadIdsFrom(JSON.parse(body));
        deadFromUsed = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) notice(`ℹ 读不到 ${deadFrom}，按未排除处理`);
  }
}

// 合并去重（用户显式写的在前，状态文件的在后）；--dead-from 不给时 deadExclude 为空，行为与旧版一致。
const exclude = [...new Set([...flagExclude, ...deadExclude])];

// --exclude 优先于 --dead-from：用户手写的意图更明确。
const excludedBy = flagExclude.length ? "flag" : deadExclude.length ? "dead-file" : "none";

// 兜底口径自检：两处 DEFAULT_LIMITS 必须一致，否则分数不可复现。
if (DEFAULT_LIMITS.context !== CATALOG_LIMITS.context || DEFAULT_LIMITS.output !== CATALOG_LIMITS.output) {
  process.stderr.write("score: 警告 —— score.mjs 的 DEFAULT_LIMITS 与 catalog.mjs 不一致\n");
}

const rows = rankModels(CATALOG, { profile, limit, exclude });
// 只对 --exclude 手写的 id 报「不在目录中」；状态文件里的历史 id 不算用户笔误。
const excludedUnknown = flagExclude.filter((id) => !CATALOG.some((m) => m.id === id));

if (wantJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        profile,
        limit,
        weights: PROFILE_WEIGHTS[profile],
        total: CATALOG.length,
        excluded: exclude,
        excludedUnknown,
        excludedBy,
        deadFrom: deadFromUsed ? deadFrom : null,
        returned: rows.length,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const out = [];
out.push("");
out.push(`模型评分 · profile=${profile} · ${PROFILE_HINTS[profile]}`);
out.push(
  `权重 context ${PROFILE_WEIGHTS[profile].context} / output ${PROFILE_WEIGHTS[profile].output} / ` +
    `price ${PROFILE_WEIGHTS[profile].price} / capability ${PROFILE_WEIGHTS[profile].capability}` +
    `　·　目录 ${CATALOG.length} 条${exclude.length ? `，排除 ${exclude.length} 条` : "，未排除任何模型"}`,
);
// --dead-from 生效时把「排除了谁、来自哪」写清楚，避免排序结果无法对账。
if (deadFromUsed) {
  out.push(
    `ℹ --dead-from ${deadFrom}：排除 ${deadExclude.length} 个已判死模型` +
      `${deadExclude.length ? `（${deadExclude.slice(0, 6).join(", ")}${deadExclude.length > 6 ? " …" : ""}）` : ""}`,
  );
}
out.push("");

const nw = Math.min(44, Math.max(10, ...rows.map((r) => width(r.id))));
const header = `  ${pad("#", 3)}${pad("模型 id", nw + 2)}${pad("分数", 8)}${pad("ctx", 7)}${pad("out", 7)}${pad("price", 7)}${pad("cap", 7)}标签`;
out.push(header);
out.push(`  ${"-".repeat(width(header) - 2)}`);
rows.forEach((r, i) => {
  out.push(
    `  ${pad(String(i + 1), 3)}${pad(r.id, nw + 2)}${pad(r.score.toFixed(4), 8)}` +
      `${pad(r.parts.context.toFixed(2), 7)}${pad(r.parts.output.toFixed(2), 7)}` +
      `${pad(r.parts.price.toFixed(2), 7)}${pad(r.parts.capability.toFixed(2), 7)}${r.tags.join(",")}`,
  );
});
out.push("");

// 前三名各给一段「为什么」，让排序能对账而不是只能信。
out.push(`为什么前 3 名是这个分（profile=${profile}）：`);
for (const r of rows.slice(0, 3)) {
  const model = CATALOG.find((m) => m.id === r.id);
  const lines = explain(model, profile);
  out.push(`  · ${r.id}　${r.name}`);
  for (const line of lines) out.push(`      ${line}`);
}
out.push("");

if (excludedUnknown.length) out.push(`提示：--exclude 里有 ${excludedUnknown.length} 个 id 不在目录中：${excludedUnknown.join(", ")}`);
out.push(
  `换 profile 试试：${PROFILES.filter((p) => p !== profile).map((p) => `--profile ${p}`).join("　")}` +
    `${explicitNoFilter ? "（--include-dead 已生效：确实没排除任何模型）" : ""}`,
);
out.push("想看完整 91 条用 --all；给脚本读用 --json（含各维度分与兜底留痕）。");

// 五档前 3 的一句话速览，回答「我到底该选哪个」这个原始问题。
const all = compareProfiles(CATALOG);
out.push("");
out.push("五档各自前 3：");
for (const p of PROFILES) {
  out.push(`  ${pad(p, 14)}${all[p].map((x) => `${x.id}(${x.score.toFixed(3)})`).join("  ")}`);
}
out.push("");

process.stdout.write(`${out.join("\n")}\n`);
process.exit(0);
