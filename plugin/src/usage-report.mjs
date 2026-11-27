// plugin/src/usage-report.mjs —— 用量 / 费用的纯展示层（零 import：不碰 IO、网络、console、node:）
//
// 上游单位铁律：usage-api.mjs 的 normalizeUsageSeries() 给的 input / output / cached
// 都是 **kToken**（千 token 数）。本模块只在 toTokens() 一处 ×1000 换回 token，
// 其它所有导出（dailyRows / modelRows / tokenTotal / formatTokens / summaryLine）
// 都按 token 走。谁要改单位，只改 toTokens()，别在这里撒几处 *1000。

const K_TO_TOKEN = 1000;

/** 上游单位是 kToken → token。整个模块唯一的换算点（见文件头）。 */
function toTokens(kToken) {
  const n = typeof kToken === "number" ? kToken : Number(kToken);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.round(n * K_TO_TOKEN);
}

const round = (v, d = 2) => Number(Number(v).toFixed(d));

function text(v) {
  return v == null ? "" : String(v);
}

/**
 * 桶的 `time`（ISO 字符串 / 时间戳 / 日期串）→ `YYYY-MM-DD`；认不出来就给 ""。
 * 只截日期，不问时区：上游已经按请求时的 timezone 分好桶了。
 */
function dateKey(time) {
  const s = text(time).trim();
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

/**
 * 分模型序列 → 按天的 token 行，日期升序。
 *
 * 抽桶规则：从每个模型的 `buckets[].time` 取日期，把同一天所有模型的桶加在一起。
 * 退化规则（很重要）：某条模型**没有 buckets**（上游只给汇总值）时，整段序列当
 * 「一天」处理，`date` 用 `""` —— 不猜日期、不抛错，调用方看到空 date 就知道要
 * 显示「（全部）」。
 *
 * @param {Array<{model?:string,input?:number,output?:number,cached?:number,buckets?:Array<{time?:string,input?:number,output?:number}>}>} series
 *        normalizeUsageSeries() 的返回值（单位 kToken）
 * @returns {Array<{date:string,input:number,output:number,cached:number,total:number}>} 单位 token
 */
export function dailyRows(series) {
  const list = Array.isArray(series) ? series : [];
  if (!list.length) return [];

  const byDate = new Map();
  const accOf = (date) => {
    let acc = byDate.get(date);
    if (!acc) {
      acc = { date, input: 0, output: 0, cached: 0, total: 0 };
      byDate.set(date, acc);
    }
    return acc;
  };

  let sawBucket = false;
  for (const row of list) {
    const buckets = Array.isArray(row?.buckets) ? row.buckets : [];
    if (!buckets.length) continue;
    sawBucket = true;
    const cachedTokens = toTokens(row?.cached);
    const weights = buckets.map((b) => toTokens(b?.input) + toTokens(b?.output));
    const sumWeight = weights.reduce((a, b) => a + b, 0);
    buckets.forEach((b, i) => {
      const acc = accOf(dateKey(b?.time));
      acc.input += toTokens(b?.input);
      acc.output += toTokens(b?.output);
      // 上游桶里没有 cached 字段，但模型行上有：按该行各桶的 token 占比摊到桶上
      // （四舍五入到整数；各桶之和可能与行值差 1~2 个 token，这是刻意取舍）。
      if (cachedTokens > 0 && sumWeight > 0) {
        acc.cached += Math.round((cachedTokens * weights[i]) / sumWeight);
      }
    });
  }

  if (!sawBucket) {
    // 没有 buckets：全部算一天，date 留空（别填空洞日期骗用户）。
    const acc = accOf("");
    for (const row of list) {
      acc.input += toTokens(row?.input);
      acc.output += toTokens(row?.output);
      acc.cached += toTokens(row?.cached);
    }
  }

  const out = [...byDate.values()];
  for (const r of out) r.total = r.input + r.output;
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * 分模型序列 → 按模型的 token 行，total 降序（同 total 按模型名升序，保证稳定）。
 * `share` = 该模型 total / 全部 total（0..1）；总量为 0 时一律 0（不做 0/0）。
 */
export function modelRows(series) {
  const list = Array.isArray(series) ? series : [];
  const rows = list.map((row) => {
    const input = toTokens(row?.input);
    const output = toTokens(row?.output);
    return {
      model: text(row?.model).trim() || "unknown",
      input,
      output,
      cached: toTokens(row?.cached),
      total: input + output,
      share: 0,
    };
  });
  const grand = rows.reduce((a, r) => a + r.total, 0);
  for (const r of rows) r.share = grand > 0 ? r.total / grand : 0;
  rows.sort((a, b) => b.total - a.total || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return rows;
}

/**
 * 任意行集合（dailyRows / modelRows 都行）→ token 合计。
 * 注意：入参行里的 input/output/cached **已经是 token**（本模块的其它导出都换过了），
 * 所以这里只做加法，绝不再 ×1000 —— 单位换算只发生在 toTokens() 一处。
 */
export function tokenTotal(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const intOf = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  const out = { input: 0, output: 0, cached: 0, total: 0 };
  for (const r of list) {
    out.input += intOf(r?.input);
    out.output += intOf(r?.output);
    out.cached += intOf(r?.cached);
  }
  out.total = out.input + out.output;
  return out;
}

/**
 * 人读的 token 数：≥1 亿 → "1.23 亿"，≥1 万 → "4.5 万"，否则 "812"。
 * 与 usage.mjs 的 tokensText() 同口径，但本模块不 import 它（零依赖铁律）。
 */
export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  if (v >= 1e8) return `${round(v / 1e8, 2)} 亿`;
  if (v >= 1e4) return `${round(v / 1e4, 1)} 万`;
  return String(Math.round(v));
}

/** 显示宽度：`[^\x00-\xff]` 记 2 列（中文 / 全角标点），其余 1 列。 */
function displayWidth(s) {
  let n = 0;
  for (const ch of text(s)) n += /[^\x00-\xff]/.test(ch) ? 2 : 1;
  return n;
}

function padCell(s, width, align) {
  const fill = " ".repeat(Math.max(0, width - displayWidth(s)));
  return align === "right" ? fill + s : s + fill;
}

/**
 * 等宽表（中文按 2 列宽算）。
 * 列宽取「表头 + 所有单元格」里最宽的那一个；列间用 2 个空格；
 * 行尾不留多余空格（右对齐列也只在内部补空格）。
 *
 * @param {{title?:string, headers?:string[], rows?:Array<Array<string|number>>, aligns?:Array<"left"|"right">}} spec
 * @returns {string[]} 每一行一条；`rows` 为空时仍然返回 title（若有）+ 表头
 */
export function renderTable({ title, headers, rows, aligns } = {}) {
  const head = Array.isArray(headers) ? headers.map(text) : [];
  const body = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r.map(text) : []));
  const cols = Math.max(head.length, ...body.map((r) => r.length), 0);
  if (!cols) return title ? [text(title)] : [];

  const align = (i) => (Array.isArray(aligns) && aligns[i] === "right" ? "right" : "left");
  const widths = [];
  for (let i = 0; i < cols; i++) {
    let w = i < head.length ? displayWidth(head[i]) : 0;
    for (const r of body) if (i < r.length) w = Math.max(w, displayWidth(r[i]));
    widths.push(w);
  }

  const renderLine = (cells) => {
    const parts = [];
    for (let i = 0; i < cols; i++) parts.push(padCell(i < cells.length ? cells[i] : "", widths[i], align(i)));
    return parts.join("  ").replace(/ +$/, "");
  };

  const lines = [];
  if (title) lines.push(text(title));
  if (head.length) lines.push(renderLine(head));
  for (const r of body) lines.push(renderLine(r));
  return lines;
}

/** 金额：0 → "0"，不足 1 分 → 4 位小数，其余 2 位（与 usage.mjs 的 yuan() 同口径）。 */
function yuanText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0";
  if (Math.abs(n) < 0.01) return n.toFixed(4);
  return round(n, 2).toFixed(2);
}

/** `cost` 允许传数字、`{ totalFee }`、或 null/undefined（= 没查费用）。 */
function costOf(cost) {
  if (cost == null || cost === "") return null;
  const raw = typeof cost === "object" ? cost.totalFee : cost;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? yuanText(n) : null;
}

/**
 * 一行中文总结，例：「近 7 天 1.2 亿 tokens · 花费 ¥3.45 · 日均 1700 万」。
 * 没查费用（cost 为 null/undefined）时省掉「花费」那段，而不是写 ¥0 骗人。
 *
 * @param {{days?:number, total?:number|{total:number}, cost?:number|{totalFee:number}|null}} spec
 */
export function summaryLine({ days, total, cost } = {}) {
  const d = Math.max(1, Math.trunc(Number(days)) || 1);
  const raw = total && typeof total === "object" ? total.total : total;
  const t = Number(raw);
  const tokens = Number.isFinite(t) ? t : 0;
  const parts = [`近 ${d} 天 ${formatTokens(tokens)} tokens`];
  const fee = costOf(cost);
  if (fee !== null) parts.push(`花费 ¥${fee}`);
  parts.push(`日均 ${formatTokens(tokens / d)}`);
  return parts.join(" · ");
}
