#!/usr/bin/env node
// tools/check.mjs — 宿主侧环境体检：插件装没装对、provider 有没有被置 off、账号有没有 key、
// 代理、magpie 在不在 PATH、仓库全不全、Node 版本。
//
// 和 tools/doctor.mjs 的分工（两边查的东西不重叠，出问题现象却一样，都是「模型不出字」）：
//   tools/check.mjs   宿主侧：不需要账号、不联网、不发请求，只看本机现场
//   tools/doctor.mjs  账号侧：要 Key，会打上游（Key 有效性 / 余额 / TPD / 模型矩阵 / options）
// 先跑 check 再跑 doctor：宿主侧不对的话，doctor 的结论会误导你往账号上找原因。
//
// 用法：node tools/check.mjs [--json] [--fix] [--apply] [--config-dir <path>] [--repo <path>] [--help]
// 铁律：绝不打印 Key / AK / SK；proxy 只显示 host:port。退出码 0 全通 / 1 需处理 / 2 用法错误。
//
// --fix / --apply 的安全模型照抄 tools/doctor.mjs 的 options 自愈：
//   --fix    dry-run，只打印计划（一条命令都不跑、一个字节都不写）
//   --apply  真执行：先备份 → 逐条 spawnSync → 原样打印 stdout/stderr → 汇总成功/失败
// 只自动修两类（provider on / 多余的 plugin rm），其余一律列成「要人工处理」。
// 不重启 magpie、不碰 plugin-auth.json。

import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
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
  OPTIONAL_REPO_FILES,
  planRepair,
  REQUIRED_REPO_FILES,
  renderChecks,
  summarize,
} from "../plugin/src/check.mjs";
import { PROVIDER, VERSION } from "../plugin/src/config.mjs";

// UTF-8 铁律（陷阱 #1）：被 cmd / 计划任务拉起时写 "✓" 会 UnicodeEncodeError
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.reconfigure({ encoding: "utf-8", errors: "replace" });
  } catch {
    /* 老运行时没有 reconfigure，忽略 */
  }
}

const argv = process.argv.slice(2);
const usage = `magpie-qiniu 宿主侧体检 ${VERSION}

用法：node tools/check.mjs [选项]

  --json                机器可读输出（单行 JSON）
  --fix                 自愈**预览**（dry-run：只打印计划，一条命令都不跑、一个字节都不写）
  --apply               真的执行自愈计划（隐含 --fix；先备份再逐条执行）
  --config-dir <path>   magpie 配置目录（默认 $MAGPIE_CONFIG_DIR 或 ~/.config/magpie）
  --repo <path>         仓库根目录（默认由脚本位置推出来）
  --help, -h            显示本帮助

--fix / --apply 只自动修两类：provider 被置 off（→ magpie provider on <id>）、
同一插件装了多条 spec（→ magpie plugin rm <多余的那条>）。
账号为空 / 缺 sk- Key / 仓库文件缺失 / Node 版本 / 代理 / magpie 不在 PATH 这些
一律只列成「要人工处理」，不改、不猜。
--fix 与 --apply 同时给时 --apply 优先（等价于只给 --apply）。
--json 与 --apply 同时给时只输出计划 JSON、**不执行**（执行要人盯着逐条输出）。
执行前备份 <config-dir>/plugins.json（计划里有 plugin-rm 时）与 providers.json
（计划里有 provider-on 时）为 <文件名>.bak-check-<yyyyMMdd-HHmmss>；不重启 magpie。

查的是**宿主侧**（插件/provider/账号数量/代理/magpie/仓库/Node）；
Key 有效性、余额、TPD、模型矩阵这些**账号侧**的问题用 node tools/doctor.mjs。

退出码：0 全通 / 1 有 bad 或 warn（含 --apply 有命令失败）/ 2 用法错误
`;

const KNOWN_FLAGS = new Set(["--json", "--fix", "--apply", "--config-dir", "--repo", "--help", "-h"]);

function argValue(flag, fallback = "") {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  return String(argv[i + 1]);
}

// ── 参数校验（用法错误一律 2，别混进 1） ──────────────────────────────────────
let usageError = "";
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith("-")) continue;
  if (!KNOWN_FLAGS.has(a)) {
    usageError = `不认识的参数：${a}`;
    break;
  }
  if (a === "--config-dir" || a === "--repo") {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) {
      usageError = `${a} 缺少路径`;
      break;
    }
    i += 1;
  }
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}
if (usageError) {
  process.stderr.write(`${usageError}\n\n${usage}`);
  process.exit(2);
}

const wantJson = argv.includes("--json");
const wantApply = argv.includes("--apply");
const wantFix = wantApply || argv.includes("--fix"); // --apply 隐含 --fix；两个都给时 --apply 优先
const repoRoot = argValue("--repo", join(dirname(fileURLToPath(import.meta.url)), ".."));
const configDir = argValue("--config-dir", process.env.MAGPIE_CONFIG_DIR || join(homedir(), ".config", "magpie"));
const providerId = PROVIDER;

/** 读 JSON；文件不存在或坏了都返回 undefined（检查项自己会报「读不到」）。 */
function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      return JSON.parse(raw.replace(/^\uFEFF/, ""));
    }
  } catch {
    return undefined;
  }
}

const pluginsPath = join(configDir, "plugins.json");
const providersPath = join(configDir, "providers.json");
const settingsPath = join(configDir, "settings.json");
const authPath = join(configDir, "plugin-auth.json");

// 仓库已有文件：只探不读，交给 checkRepoFiles 判缺哪个
const repoHave = [...REQUIRED_REPO_FILES, ...OPTIONAL_REPO_FILES].filter((rel) => existsSync(join(repoRoot, rel)));

/** magpie 可执行文件：先 MAGPIE_BIN，再遍历 PATH（existsSync，不 spawn 进程）。 */
function findMagpieBinary() {
  const fromEnv = String(process.env.MAGPIE_BIN || "").trim();
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    // 指了个不存在的路径，最值得说清楚 —— 直接报出来
    return { path: "", note: `MAGPIE_BIN 指向的 ${fromEnv} 不存在` };
  }
  const names = process.platform === "win32" ? ["magpie.exe", "magpie.com", "magpie"] : ["magpie"];
  const dirs = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* 非法 PATH 条目，跳过 */
      }
    }
  }
  return "";
}

const checks = [
  checkNode(process.versions.node),
  checkRepoFiles(repoHave),
  checkPluginInstalled(readJson(pluginsPath), { spec: "qiniu", source: pluginsPath }),
  checkProviderSwitched(readJson(providersPath), { id: providerId, source: providersPath }),
  checkAccounts(readJson(authPath), { id: providerId, source: authPath }),
  checkProxy(readJson(settingsPath)),
  checkMagpieBinary(findMagpieBinary()),
];

const result = summarize(checks);

// ── 自愈计划（--fix 预览 / --apply 真执行）──────────────────────────────────
// 纯逻辑在 plugin/src/check.mjs 的 planRepair/describeRepair，这里只负责备份、执行、打印。
const repairPlan = wantFix ? planRepair({ checks }) : null;

if (wantJson) {
  const payload = { ...result, version: VERSION, repo: repoRoot, configDir, provider: providerId };
  if (wantFix) {
    payload.repair = {
      dryRun: !wantApply,
      executed: false, // --json 下从不执行，见 usage
      empty: isEmptyRepair(repairPlan),
      actions: repairPlan.actions,
      manual: repairPlan.manual,
      lines: describeRepair(repairPlan),
    };
  }
  for (const line of renderChecks(payload, { json: true })) process.stdout.write(`${line}\n`);
} else {
  process.stdout.write(`=== magpie-qiniu 宿主侧体检 · ${providerId}@${VERSION} ===\n`);
  process.stdout.write(`仓库：${repoRoot}\n`);
  process.stdout.write(`配置：${configDir}\n\n`);
  for (const line of renderChecks(result, { json: false })) process.stdout.write(`${line}\n`);
  process.stdout.write("\n=== 总结 ===\n");
  if (result.ok) {
    process.stdout.write("✓ 环境全通（宿主侧没发现问题；账号侧再跑 node tools/doctor.mjs）\n");
  } else {
    if (result.bads.length) {
      process.stdout.write(`✗ ${result.bads.length} 项阻塞：\n`);
      for (const b of result.bads) process.stdout.write(`  · ${b}\n`);
    }
    if (result.warns.length) {
      process.stdout.write(`⚠ ${result.warns.length} 项待处理：\n`);
      for (const w of result.warns) process.stdout.write(`  · ${w}\n`);
    }
    const first = checks.find((c) => c.level === "bad") || checks.find((c) => c.level === "warn");
    if (first) process.stdout.write(`最可能的一环：${first.label} —— ${first.hint}\n`);
  }
}

// ── 自愈：预览 / 执行 ───────────────────────────────────────────────────────
if (wantFix && !wantJson) {
  const out = (s = "") => process.stdout.write(`${s}\n`);
  out("");
  out(wantApply ? "-- 宿主侧自愈（--apply，真执行） --" : "-- 宿主侧自愈（--fix，只预览） --");

  if (isEmptyRepair(repairPlan)) {
    out("[ok] 没有能自动修的东西");
    if (!wantApply) out(`  （只读了 ${configDir}，一个字节都没写、一条命令都没跑）`);
  } else {
    for (const line of describeRepair(repairPlan)) out(`  · ${line}`);
  }

  const manualLines = describeManual(repairPlan);
  if (manualLines.length) {
    out("  以下要人工处理（这次不会动它们）：");
    for (const line of manualLines) out(`  ! ${line}`);
  }

  if (!wantApply) {
    out("  只预览：一个字节都没写、一条命令都没跑；加 --apply 才会真正执行");
  } else if (!isEmptyRepair(repairPlan)) {
    // 执行顺序：① 备份（失败就不动手）→ ② 逐条 spawnSync → ③ 汇总。中途失败也继续跑完剩下的。
    const planActions = repairPlan.actions;
    const needPluginsBak = planActions.some((a) => a.kind === "plugin-rm");
    const needProvidersBak = planActions.some((a) => a.kind === "provider-on");

    /** plugins.json.bak-check-<yyyyMMdd-HHmmss>（同目录，与 doctor 的时间戳口径一致）。 */
    const stampNow = () => {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    };

    const stamp = stampNow();
    const backups = [];
    const backfired = [];
    for (const [want, file] of [
      [needPluginsBak, "plugins.json"],
      [needProvidersBak, "providers.json"],
    ]) {
      if (!want) continue;
      const src = join(configDir, file);
      if (!existsSync(src)) {
        backfired.push(`${src} 不存在，无法备份`);
        continue;
      }
      const dest = `${src}.bak-check-${stamp}`;
      try {
        copyFileSync(src, dest); // provider on 其实不改文件，但为了能整体还原也备份
        backups.push(dest);
      } catch (e) {
        backfired.push(`备份 ${src} 失败：${e?.message || e}`);
      }
    }
    for (const b of backups) out(`  备份：${b}`);
    if (backfired.length) {
      for (const b of backfired) out(`  [x] ${b}`);
      out("  备份没做成 → 一条命令都不执行（宁可不动，也不要在没有退路的情况下改现场）");
      process.exitCode = 1;
    } else {
      const bin = String(process.env.MAGPIE_BIN || "").trim() || "magpie";
      let okCount = 0;
      let failCount = 0;
      for (const action of planActions) {
        const shown = [bin, ...action.args].join(" ");
        out(`  $ ${shown}`);
        const r = spawnSync(bin, action.args, { encoding: "utf8" });
        if (r.stdout) for (const l of String(r.stdout).replace(/\n$/, "").split("\n")) out(`    ${l}`);
        if (r.stderr) for (const l of String(r.stderr).replace(/\n$/, "").split("\n")) out(`    ${l}`);
        const failed = r.error || r.status !== 0;
        if (r.error) out(`    [x] 执行失败：${r.error.message}`);
        else out(`    [status ${r.status}]`);
        if (failed) {
          failCount += 1;
          out(`  [x] 失败：${shown}（继续执行剩余条目）`);
        } else {
          okCount += 1;
        }
      }
      out(`  汇总：成功 ${okCount} / 失败 ${failCount}`);
      if (failCount) process.exitCode = 1;
    }
  }

  out("  重跑 `node tools/check.mjs` 验证（不重启 magpie：下条命令/下次插件加载就生效）");
}

if (process.exitCode !== 1) process.exitCode = result.ok ? 0 : 1;
