// src/fix.mjs — options 自愈的**纯逻辑层**（无 I/O、无 fs、无 console、不联网）。
//
// 为什么拆出来：会改用户配置文件的代码一旦里带 I/O，就没法在测试里反复演练
// 「脏配置 → 干净配置」的全过程。所以这里只做三件事：
//   planFix      : 把 doctor.optionsAudit() 的结论翻译成「要删什么、要改成什么」
//   applyPlan    : 按计划生成**新的** options 对象（不改入参、不写文件）
//   describePlan : 把计划说成人话（CLI 与 --json 共用同一口径）
//
// 安全口径（与 tools/doctor.mjs 的 --fix/--apply 约定一致）：
//   · 只处理 options 这一层的键，不碰 provider 状态、不碰账号；
//   · remove 只来自 audit.legacy ∪ audit.unknown（从未实现的 / 拼错的）；
//   · set   只来自 audit.clamped，且只写「实际生效值」，绝不写用户原值；
//   · 其余键原样保留（applyPlan 保序），一个字节都不动。

import { LEGACY_OPTIONS } from "./doctor.mjs";

/** 安全地把任意输入收敛成普通对象（null / 数组 / 标量都当空对象）。 */
function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** 安全地收敛成字符串数组。 */
function asKeys(v) {
  return Array.isArray(v) ? v.map((k) => String(k)).filter(Boolean) : [];
}

/** 人话里的值：字符串原样，其它走 JSON（数字不加引号，與 describePlan 的示例一致）。 */
function fmt(v) {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  return JSON.stringify(v);
}

/**
 * 把审计结论翻译成修复计划。
 *
 * @param {{rawOptions?:object, audit?:object, effective?:object}} input
 *   rawOptions — plugins.json 里那一条插件条目的 options 原文
 *   audit      — optionsAudit(rawOptions, effective) 的返回值
 *   effective  — readOptions(rawOptions) 的生效值
 * @returns {{
 *   remove: string[], set: object, keep: string[], reasons: string[],
 *   legacy: string[], unknown: string[],
 *   clamped: {key:string, wrote:any, effective:any}[]
 * }}
 *   remove  = legacy ∪ unknown，排序去重；
 *   set     = clamped 里 wrote !== effective 的那些键 → 生效值；
 *   keep    = 其余键（保序，用于核对「没被碰」）；
 *   reasons = 逐条中文理由（--json 用）；
 *   legacy / unknown / clamped 是给 describePlan 用的明细（remove/set 已经合并了它们）。
 */
export function planFix({ rawOptions, audit, effective } = {}) {
  const raw = asObject(rawOptions);
  const a = asObject(audit);
  const eff = asObject(effective);

  const legacy = asKeys(a.legacy);
  const unknown = asKeys(a.unknown);
  const removeSet = new Set([...legacy, ...unknown]);
  const remove = [...removeSet].sort();

  const set = {};
  const clampedDetails = [];
  const reasons = [];

  for (const k of [...new Set(legacy)].sort()) {
    reasons.push(`删除 ${k}：从未实现的字段（CONTRACT 早期文档里出现过，readOptions 不认）`);
  }
  for (const k of [...new Set(unknown)].sort()) {
    reasons.push(`删除 ${k}：不认识的键（多半是拼错，写了也不生效）`);
  }

  for (const entry of Array.isArray(a.clamped) ? a.clamped : []) {
    const key = String(entry?.key ?? "");
    if (!key) continue;
    if (removeSet.has(key)) continue; // 已经在删除名单里，不再改写
    const wrote = entry?.wrote;
    // 生效值优先取 effective 里的真实值（audit 里的 effective 是同一个来源，仅兜底）
    const target = Object.hasOwn(eff, key) ? eff[key] : entry?.effective;
    if (target === undefined) continue;
    let same = false;
    try {
      same = JSON.stringify(wrote) === JSON.stringify(target);
    } catch {
      same = false;
    }
    if (same) continue; // 本来就等于生效值，无事可做
    set[key] = target;
    clampedDetails.push({ key, wrote, effective: target });
    reasons.push(`改写 ${key}：${fmt(wrote)} → ${fmt(target)}（写入值会被夹紧，改成实际生效值）`);
  }

  const setKeys = new Set(Object.keys(set));
  const keep = Object.keys(raw).filter((k) => !removeSet.has(k) && !setKeys.has(k));

  return { remove, set, keep, reasons, legacy, unknown, clamped: clampedDetails };
}

/**
 * 按计划生成新的 options 对象（纯函数：入参保持脏样子，返回的是新对象）。
 * 键顺序沿用原 options 的顺序，被 set 的键就地替换值。
 *
 * @param {object} rawOptions 原 options
 * @param {object} plan planFix 的返回值
 * @returns {object} 新 options
 */
export function applyPlan(rawOptions, plan = {}) {
  const raw = asObject(rawOptions);
  const p = asObject(plan);
  const remove = new Set(asKeys(p.remove));
  const set = asObject(p.set);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (remove.has(k)) continue;
    out[k] = Object.hasOwn(set, k) ? set[k] : v;
  }
  // 兜底：计划里要 set 但原文没有的键也补上（正常流程不会出现）
  for (const [k, v] of Object.entries(set)) {
    if (!Object.hasOwn(out, k)) out[k] = v;
  }
  return out;
}

/**
 * 计划 → 人话（一行一件事）。空计划返回空数组。
 * @param {object} plan planFix 的返回值
 * @returns {string[]}
 */
export function describePlan(plan = {}) {
  const p = asObject(plan);
  const lines = [];

  // 明细优先用 planFix 给的 legacy/unknown；外部手搓 plan 时按 LEGACY_OPTIONS 兜底分类
  const remove = asKeys(p.remove);
  const legacy = Array.isArray(p.legacy) ? asKeys(p.legacy) : remove.filter((k) => LEGACY_OPTIONS.includes(k));
  const unknown = Array.isArray(p.unknown) ? asKeys(p.unknown) : remove.filter((k) => !LEGACY_OPTIONS.includes(k));

  if (legacy.length) lines.push(`删除从未实现的字段：${legacy.join(", ")}`);
  if (unknown.length) lines.push(`删除不认识的字段（多半是拼错）：${unknown.join(", ")}`);

  const set = asObject(p.set);
  const details = new Map((Array.isArray(p.clamped) ? p.clamped : []).map((c) => [String(c?.key ?? ""), c]));
  for (const key of Object.keys(set)) {
    const c = details.get(key);
    if (c) lines.push(`${key}：${fmt(c.wrote)} → ${fmt(c.effective ?? set[key])}`);
    else lines.push(`${key}：→ ${fmt(set[key])}`);
  }
  return lines;
}

/**
 * 计划是否为空（空 = CLI 直接说「没有需要修的东西」，不备份、不写文件）。
 * @param {object} plan planFix 的返回值
 * @returns {boolean}
 */
export function isEmptyPlan(plan = {}) {
  const p = asObject(plan);
  const remove = asKeys(p.remove);
  const set = asObject(p.set);
  return remove.length === 0 && Object.keys(set).length === 0;
}
