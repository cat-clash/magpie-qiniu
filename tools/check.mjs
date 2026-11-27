#!/usr/bin/env node
// tools/check.mjs — 宿主侧环境体检：插件装没装对、provider 有没有被置 off、账号有没有 key、
// 代理、magpie 在不在 PATH、仓库全不全、Node 版本。
//
// 和 tools/doctor.mjs 的分工（两边查的东西不重叠，出问题现象却一样，都是「模型不出字」）：
//   tools/check.mjs   宿主侧：不需要账号、不联网、不发请求，只看本机现场
//   tools/doctor.mjs  账号侧：要 Key，会打上游（Key 有效性 / 余额 / TPD / 模型矩阵 / options）
// 先跑 check 再跑 doctor：宿主侧不对的话，doctor 的结论会误导你往账号上找原因。
//
// 用法：node tools/check.mjs [--json] [--config-dir <path>] [--repo <path>] [--help]
// 铁律：绝不打印 Key / AK / SK；proxy 只显示 host:port。退出码 0 全通 / 1 需处理 / 2 用法错误。

import { readFileSync, existsSync } from "node:fs";
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
  OPTIONAL_REPO_FILES,
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
  --config-dir <path>   magpie 配置目录（默认 $MAGPIE_CONFIG_DIR 或 ~/.config/magpie）
  --repo <path>         仓库根目录（默认由脚本位置推出来）
  --help, -h            显示本帮助

查的是**宿主侧**（插件/provider/账号数量/代理/magpie/仓库/Node）；
Key 有效性、余额、TPD、模型矩阵这些**账号侧**的问题用 node tools/doctor.mjs。

退出码：0 全通 / 1 有 bad 或 warn / 2 用法错误
`;

const KNOWN_FLAGS = new Set(["--json", "--config-dir", "--repo", "--help", "-h"]);

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

if (wantJson) {
  const payload = { ...result, version: VERSION, repo: repoRoot, configDir, provider: providerId };
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

process.exitCode = result.ok ? 0 : 1;
