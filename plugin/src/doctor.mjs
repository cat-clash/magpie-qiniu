// src/doctor.mjs — 一键诊断的**纯逻辑层**（无 I/O、无网络、无 console）。
//
// 为什么要拆出来：诊断的输出最容易退化成「只有本机跑得通的一段脚本」，
// 所以判定规则全部做成纯函数，`tools/doctor.mjs` 只负责读文件、发请求、打印。
// 测试直接喂构造好的上游响应，不需要联网，也不需要 magpie 在场。
//
// 判定口径来自实地踩过的坑（docs/troubleshooting.md 全部条目）：
//   · 403 `account_billing_suspended` = 账号欠费停用，不是 Key 问题、也不是限流；
//   · 429 `rate limit reached for TPD` = 账号级日窗口，换 Key 无效，等 +08 零点；
//   · 401 = Key 真的废了，要重新登录；
//   · 余额为负但还有生效资源包 → 仍可能可以调用（七牛先扣包），别急着报死。

/** 诊断级别：ok 通过 / warn 能跑但要处理 / bad 现在跑不了。 */
export const LEVELS = ["ok", "warn", "bad"];

/** 历史文档里出现过、但从未实现的 options —— 用户照着旧文档填了也不会生效。 */
export const LEGACY_OPTIONS = [
  "baseUrl",
  "chatTimeoutMs",
  "autoCreateKey",
  "showAllModels",
  "modelOverrides",
  "extraHeaders",
  "dailyUsageDays",
];

/**
 * Key 探测结果 → 结论。
 * @param {{status:number, code?:string, message?:string}} probe 一次匿名/带 Key 的探测结果
 */
export function classifyKeyProbe(probe = {}) {
  const status = Number(probe.status) || 0;
  const text = `${probe.code || ""} ${probe.message || ""}`.toLowerCase();
  if (!status) {
    return { level: "bad", verdict: "连不上上游（网络或代理）", hint: "先确认能访问 api.qnaigc.com；企业代理可能要放行它" };
  }
  if (status === 200) return { level: "ok", verdict: "Key 有效" };
  if (status === 401) return { level: "bad", verdict: "Key 无效或已删除（401）", hint: "重新登录：magpie plugin login qiniu-ai" };
  if (status === 403) {
    if (/billing|suspend|arrears|欠费|停用/.test(text)) {
      return { level: "bad", verdict: "账号欠费/停用（403 billing suspended）", hint: "充值或领资源包，结清后约 20 分钟解封；插件会把它改判成 429 arrears" };
    }
    if (/model groups|subscription|not available/.test(text)) {
      return { level: "warn", verdict: "这把 Key 的模型组不含目标模型（403）", hint: "控制台调整 Key 的模型组，或换一把不设限的 Key" };
    }
    return { level: "warn", verdict: "上游 403（非欠费类）", hint: "看原始 body 的 code 再判断" };
  }
  if (status === 429) {
    if (/tpd/i.test(text)) {
      return { level: "warn", verdict: "今日 TPD 已到上限（429）", hint: "账号级日窗口，换 Key 无效；等下一个 +08 零点重置" };
    }
    if (/rpm|tpm/i.test(text)) {
      return { level: "warn", verdict: "分钟级限流（429 RPM/TPM）", hint: "调小 maxConcurrency，或把 pacingMinMs 调大" };
    }
    return { level: "warn", verdict: "上游 429（限流）", hint: "等一会儿；插件会按缺口类型补 retry-after" };
  }
  if (status >= 500) return { level: "warn", verdict: `上游 ${status}`, hint: "上游抖动，隔几分钟重试" };
  return { level: "warn", verdict: `上游 ${status}`, hint: "看原始 body" };
}

/**
 * 余额 / 资源包 → 结论。两个口径都要看：七牛先扣资源包，再扣现金。
 * @param {{available?:number|null, unpaid?:number|null}} balance
 * @param {{totalRest?:number, packCount?:number}|undefined} pack
 */
export function classifyBalance(balance, pack) {
  const available = balance && Number.isFinite(balance.available) ? balance.available : null;
  const unpaid = balance && Number.isFinite(balance.unpaid) ? balance.unpaid : null;
  const rest = pack && Number.isFinite(pack.totalRest) ? pack.totalRest : null;
  if (available === null && rest === null) {
    return { level: "ok", verdict: "读不到余额（sk- Key 账号没有 AK/SK，属正常）", hint: "" };
  }
  if (unpaid && unpaid > 0) {
    return { level: "bad", verdict: `有 ¥${unpaid} 待付金额`, hint: "结清欠款；否则上游会整号停用" };
  }
  if (available !== null && available < 0) {
    return rest && rest > 0
      ? { level: "warn", verdict: `现金余额 ¥${available}（负），但还有 ${pack.packCount} 个资源包可用`, hint: "补钱以免下次扣款失败" }
      : { level: "bad", verdict: `现金余额 ¥${available}，且没有可用资源包`, hint: "充值或领资源包 —— 这就是 403 billing suspended 的直接原因" };
  }
  if (available === 0 && (!rest || rest <= 0)) {
    return { level: "bad", verdict: "现金余额 0，也没有可用资源包", hint: "充值或领资源包" };
  }
  if (rest !== null && rest <= 0) {
    return { level: "warn", verdict: "资源包已用尽", hint: "再领包或改用按量付费" };
  }
  const bits = [];
  if (available !== null) bits.push(`现金 ¥${available}`);
  if (rest !== null) bits.push(`资源包剩 ${pack.packCount || 1} 个共 ${rest} tokens`);
  return { level: "ok", verdict: bits.join(" · ") };
}

/** 当日 TPD → 结论。上游不公布日上限，所以只报已用量。 */
export function classifyTpd(tpd) {
  if (!tpd || !tpd.used) {
    return { level: "ok", verdict: "今日还没有用量记录", hint: "" };
  }
  const used = tpd.used;
  const text = used >= 1e8 ? `${(used / 1e8).toFixed(2)} 亿` : used >= 1e4 ? `${(used / 1e4).toFixed(1)} 万` : String(used);
  return {
    level: "ok",
    verdict: `今日已用 ${text} tokens（${tpd.models} 个模型；缓存 ${tpd.cached} tokens）`,
    hint: "上游不公布 TPD 上限；撞到会返回 429 TPD，重置于下一个 +08 零点",
  };
}

/**
 * options 自检：把用户写的原始值与 `readOptions` 生效值对比，找出
 * 被夹紧的字段、从未实现的字段、拼错的字段。
 * @param {object} raw 用户在 plugins.json 里写的 options
 * @param {object} effective readOptions(raw) 的结果
 * @param {string[]} knownKeys readOptions 认的键（默认由 effective 的键推出）
 */
export function optionsAudit(raw = {}, effective = {}, knownKeys) {
  const keys = Array.isArray(knownKeys) && knownKeys.length ? knownKeys : Object.keys(effective);
  const known = new Set(keys);
  const unknown = [];
  const legacy = [];
  const clamped = [];
  for (const [k, v] of Object.entries(raw || {})) {
    if (LEGACY_OPTIONS.includes(k)) {
      legacy.push(k);
      continue;
    }
    if (!known.has(k)) {
      unknown.push(k);
      continue;
    }
    const got = effective[k];
    if (JSON.stringify(v) !== JSON.stringify(got)) clamped.push({ key: k, wrote: v, effective: got });
  }
  return { unknown, legacy, clamped, knownKeys: keys };
}

/** 把各段结论汇总成一个可渲染的 report。 */
export function buildReport({ provider, version, accounts = [], options = {}, configWarnings = [] } = {}) {
  const bads = [];
  const warns = [];
  for (const a of accounts) {
    for (const part of a.checks || []) {
      if (part.level === "bad") bads.push(`${a.label}：${part.verdict}`);
      if (part.level === "warn") warns.push(`${a.label}：${part.verdict}`);
    }
  }
  for (const c of configWarnings) {
    if (c.level === "bad") bads.push(c.text);
    if (c.level === "warn") warns.push(c.text);
  }
  // 没有账号时无论其它项如何都不算通过：插件装了但没有凭据等于不能用
  const level = !accounts.length ? "bad" : bads.length ? "bad" : warns.length ? "warn" : "ok";
  return {
    provider,
    version,
    level,
    accounts,
    options,
    bads: accounts.length ? bads : ["没有凭据：plugin-auth.json 里找不到这个 provider 的账号"],
    warns,
    ok: level === "ok" && accounts.length > 0,
  };
}

const MARK = { ok: "[ok]", warn: "[!]", bad: "[x]" };

/**
 * → 要打印的行（纯函数，方便快照测试）。
 * @param {object} report buildReport 的返回值
 * @param {{json?:boolean}} [opts]
 */
export function renderReport(report, { json = false } = {}) {
  if (json) return [JSON.stringify(report, null, 2)];
  const lines = [];
  lines.push(`=== magpie-qiniu 诊断 · ${report.provider}@${report.version} ===`);
  lines.push("");
  if (!report.accounts.length) {
    lines.push(`${MARK.bad} 账号：plugin-auth.json 里没有 ${report.provider} 的凭据`);
    lines.push("  → 修复：magpie plugin login qiniu-ai");
    lines.push("");
  }
  for (const acc of report.accounts) {
    lines.push(`-- ${acc.label} --`);
    for (const part of acc.checks || []) {
      lines.push(`${MARK[part.level] || "[?]"} ${part.name}：${part.verdict}`);
      if (part.hint) lines.push(`  → ${part.hint}`);
    }
    lines.push("");
  }
  const audit = report.options && report.options.audit;
  if (audit) {
    const bits = [];
    if (audit.legacy.length) bits.push(`从未实现的字段 ${audit.legacy.join(", ")}`);
    if (audit.unknown.length) bits.push(`不认识的字段 ${audit.unknown.join(", ")}`);
    if (audit.clamped.length) bits.push(`被夹紧 ${audit.clamped.map((c) => `${c.key}=${JSON.stringify(c.wrote)}→${JSON.stringify(c.effective)}`).join(", ")}`);
    lines.push(`-- 配置 --`);
    lines.push(bits.length ? `${MARK.warn} ${bits.join("；")}` : `${MARK.ok} options 全部按预期生效`);
    lines.push(`  生效值：pacingMinMs=${report.options.pacingMinMs} pacingJitterMs=${report.options.pacingJitterMs} breakerThreshold=${report.options.breakerThreshold} breakerCooldownMs=${report.options.breakerCooldownMs} quotaFailover=${report.options.quotaFailover}`);
    lines.push("");
  }
  lines.push("=== 总结 ===");
  if (report.ok) {
    lines.push(`${MARK.ok} 账号 / 余额 / 用量 / 配置 全通`);
  } else {
    if (report.bads.length) {
      lines.push(`${MARK.bad} ${report.bads.length} 项阻塞：`);
      for (const b of report.bads) lines.push(`  · ${b}`);
    }
    if (report.warns.length) {
      lines.push(`${MARK.warn} ${report.warns.length} 项待处理：`);
      for (const w of report.warns) lines.push(`  · ${w}`);
    }
  }
  return lines;
}
