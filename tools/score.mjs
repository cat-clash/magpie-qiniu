#!/usr/bin/env node
// tools/score.mjs — 91 个七牛模型「我该用哪个」的一条命令答案。纯读：不联网、不写文件。
//
// 用法：
//   node tools/score.mjs                        # balanced 前 10
//   node tools/score.mjs --profile coding       # 编码榜
//   node tools/score.mjs --profile cheap --all  # 省钱的完整排序
//   node tools/score.mjs --profile vision --json
//   node tools/score.mjs --exclude a,b,c        # 手动排除（例如已知 503 的模型）
//
// 关于健康态：health.mjs 的 dead 结论活在宿主进程内存里（`~/.config/magpie` 落不了盘，也没这个文件
// 的约定），CLI 读不到，所以**默认不排除任何模型**。要按实测结果剔掉几条，用 --exclude 手动传。
// --include-dead 因此是个显式的空操作（语义：我不排除任何东西），留着是为了脚本里能对称地写。
//
// 退出码：0 成功 / 2 未知 profile 或用法错误。

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
  process.stderr.write(`用法：node tools/score.mjs [--profile ${PROFILES.join("|")}] [--limit n] [--all] [--json] [--exclude a,b] [--help]\n`);
  process.exit(2);
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// 未知参数一律 2：宁可报错，也不要让人以为筛选条件生效了。
const KNOWN = new Set(["--profile", "--limit", "--json", "--all", "--exclude", "--include-dead", "--help", "-h"]);
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

const exclude = (argValue("--exclude") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 兜底口径自检：两处 DEFAULT_LIMITS 必须一致，否则分数不可复现。
if (DEFAULT_LIMITS.context !== CATALOG_LIMITS.context || DEFAULT_LIMITS.output !== CATALOG_LIMITS.output) {
  process.stderr.write("score: 警告 —— score.mjs 的 DEFAULT_LIMITS 与 catalog.mjs 不一致\n");
}

const rows = rankModels(CATALOG, { profile, limit, exclude });
const excludedUnknown = exclude.filter((id) => !CATALOG.some((m) => m.id === id));

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
