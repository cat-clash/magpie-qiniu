#!/usr/bin/env node
// scripts/contract-diff.mjs — 契约漂移巡检（只读，不改任何文件）。
//
// 目的：把两类**静默**故障变成一条命令就能看见的差集。
//   1. 文档（CONTRACT.md / README.md）里写了某个 options 键，代码里从来没实现 —— 用户填了不生效；
//   2. 代码（plugin/src/config.mjs 的 DEFAULTS）里新加了 options 键，README「插件配置」表没写 ——
//      用户根本不知道有这个开关。
//
// 用法：
//   node scripts/contract-diff.mjs            # 人类可读
//   node scripts/contract-diff.mjs --json     # 机器可读（diffContract 的结果）
// 退出码：0 无差集 / 2 有差集 / 1 读不到文件。
//
// 硬规矩：本文件零依赖、无副作用；纯逻辑全部具名导出，供 plugin/tests/contract-diff.test.mjs 直接 import。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

/** 纯标识符：首字母打头、长度 ≥3。用来剔掉 `12`、`x`、`-Force`、`node:crypto`、URL 这类噪音。 */
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]{2,}$/;

/** 表格第一列的键：`| \`key\` | ...` */
const TABLE_KEY_RE = /^\|\s*`([A-Za-z][A-Za-z0-9_]*)`\s*\|/gm;

/** DEFAULTS 一级键：恰好缩进 2 空格 + 标识符 + 冒号（4 空格的嵌套键、注释行都抓不到）。 */
const DEFAULTS_KEY_RE = /^ {2}([A-Za-z][A-Za-z0-9_]*)\s*:/;

const uniqSorted = (arr) => [...new Set(arr)].sort();

/**
 * CONTRACT.md 里用反引号 `xxx` 提到的标识符。
 * 只收「整体就是一个标识符」的反引号片段：去重、排序、剔掉过短（`x`）与非标识符（`12`、URL、`a.b`）。
 */
export function extractDocKeys(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const m of text.matchAll(/`([^`\n]{1,120})`/g)) {
    const raw = m[1].trim();
    if (IDENT_RE.test(raw)) out.push(raw);
  }
  return uniqSorted(out);
}

/**
 * 从 config.mjs 源码文本里抽取 `export const DEFAULTS = { ... };` 的**一级**键。
 * 缩进 2 空格判断：嵌套对象的键缩进 4 空格，天然被排除。
 */
export function extractDefaultsKeys(source) {
  if (typeof source !== "string") return [];
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^export const DEFAULTS\s*=\s*\{/.test(line.trim()));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\};?\s*$/.test(line)) break; // 对象在列 0 的 `};` 收尾
    const m = DEFAULTS_KEY_RE.exec(line);
    if (m) out.push(m[1]);
  }
  return uniqSorted(out);
}

/** 取某个二级标题（`## 插件配置`）到下一个二级标题之间的正文；找不到标题就退化为全文。 */
function sectionOf(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.includes(title));
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * README「插件配置」表格第一列的键。只认 `| \`key\` |` 形式，
 * 安装参数表（`-Force`）、环境变量表（`MAGPIE_BIN`）都不在这个小节里，天然被排除。
 */
export function extractReadmeOptionKeys(text) {
  if (typeof text !== "string") return [];
  const section = sectionOf(text, "插件配置");
  const out = [];
  for (const m of section.matchAll(TABLE_KEY_RE)) out.push(m[1]);
  return uniqSorted(out);
}

/**
 * CONTRACT.md「options」表格第一列的键（= 契约里声明过的 options）。
 * CLI 用它来推导 legacyKeys：契约写了、代码从来没实现的历史字段。
 */
export function extractContractOptionKeys(text) {
  if (typeof text !== "string") return [];
  const section = sectionOf(text, "options（");
  const out = [];
  for (const m of section.matchAll(TABLE_KEY_RE)) out.push(m[1]);
  return uniqSorted(out);
}

/**
 * 三类差集。
 *   missingInReadme   代码有、README「插件配置」表没写（最容易出事：用户看不到这个开关）
 *   missingInCode     README 写了、代码里没有（用户填了不生效）；legacyKeys 里的历史字段不算错，单列
 *   missingInContract 代码有、CONTRACT.md 一字未提
 *   legacyMissingInCode（附加）legacyKeys 里确实是代码没有的那些，只报不判错
 * 全部排序去重；比较大小写敏感（options 是驼峰）。
 */
export function diffContract({ defaultsKeys = [], readmeKeys = [], contractKeys = [], legacyKeys = [] } = {}) {
  const code = new Set(defaultsKeys);
  const readme = new Set(readmeKeys);
  const contract = new Set(contractKeys);
  const legacy = new Set(legacyKeys);

  const missingInReadme = uniqSorted([...code].filter((k) => !readme.has(k)));
  const missingInCode = uniqSorted([...readme].filter((k) => !code.has(k) && !legacy.has(k)));
  const missingInContract = uniqSorted([...code].filter((k) => !contract.has(k)));
  const legacyMissingInCode = uniqSorted([...legacy].filter((k) => !code.has(k)));

  return { missingInReadme, missingInCode, missingInContract, legacyMissingInCode };
}

/** 退出码语义：0 = 无差集，2 = 有差集。legacy 只报不判错，不影响退出码。 */
export function exitCodeFor(diff) {
  if (!diff) return 0;
  const noisy = [diff.missingInReadme, diff.missingInCode, diff.missingInContract].some(
    (list) => Array.isArray(list) && list.length > 0,
  );
  return noisy ? 2 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MAX_LIST = 40;

function printList(title, note, keys) {
  process.stdout.write(`\n${title}（${note}）：${keys.length} 个\n`);
  if (keys.length === 0) {
    process.stdout.write("  - （无）\n");
    return;
  }
  for (const k of keys.slice(0, MAX_LIST)) process.stdout.write(`  - ${k}\n`);
  if (keys.length > MAX_LIST) process.stdout.write(`  … 还有 ${keys.length - MAX_LIST} 个\n`);
}

function readOne(root, rel) {
  const abs = path.join(root, rel);
  try {
    return { rel, abs, text: readFileSync(abs, "utf8") };
  } catch (err) {
    return { rel, abs, error: err && err.code ? err.code : String(err) };
  }
}

function main(argv) {
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "用法: node scripts/contract-diff.mjs [--json]\n" +
        "  只读比对 CONTRACT.md / README.md / plugin/src/config.mjs 的 options 键。\n" +
        "  退出码: 0 无差集 / 2 有差集 / 1 读不到文件\n",
    );
    return 0;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");

  const docs = [readOne(root, "CONTRACT.md"), readOne(root, "README.md"), readOne(root, "plugin/src/config.mjs")];
  const missingFiles = docs.filter((d) => d.error);
  if (missingFiles.length > 0) {
    for (const f of missingFiles) {
      process.stderr.write(`[x] 读不到文件: ${f.abs} (${f.error})\n`);
    }
    return 1;
  }

  const [contract, readme, config] = docs.map((d) => d.text);
  const contractKeys = extractDocKeys(contract);
  const contractOptionKeys = extractContractOptionKeys(contract);
  const readmeKeys = extractReadmeOptionKeys(readme);
  const defaultsKeys = extractDefaultsKeys(config);

  // 契约声明过、代码从来没实现的字段 —— 历史遗留，单独报。
  const codeSet = new Set(defaultsKeys);
  const legacyKeys = contractOptionKeys.filter((k) => !codeSet.has(k));

  const diff = diffContract({ defaultsKeys, readmeKeys, contractKeys, legacyKeys });

  if (json) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else {
    process.stdout.write(
      `契约键 ${contractKeys.length} / 代码键 ${defaultsKeys.length} / README 键 ${readmeKeys.length}\n`,
    );
    printList("missingInReadme", "代码有、README「插件配置」表没写", diff.missingInReadme);
    printList("missingInCode", "README 写了、代码里没有", diff.missingInCode);
    printList("missingInContract", "代码有、CONTRACT.md 一字未提", diff.missingInContract);
    printList(
      "legacyMissingInCode",
      "契约里的历史字段，代码从未实现；不算错，但要报",
      diff.legacyMissingInCode,
    );
    process.stdout.write(`\n退出码 ${exitCodeFor(diff)}\n`);
  }

  return exitCodeFor(diff);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
