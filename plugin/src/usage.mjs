// src/usage.mjs — 把 usage-api.mjs 的原始数据映射成 magpie 的 usage 形状。
//
// magpie 的规则（原文见 CONTRACT §3）：
//   · 厂商没给 used 就**不要传 0**；没 used 但有 amount/limit 才按比值算；
//   · 什么都没有就只给 display（路由不读它）；aside:true 的窗口永不影响路由；
//   · 任何异常都不许把面板打崩 —— 这里永远返回一个合法的 usage 对象。
// 所以本模块的原则：**能算出分母才给 used，算不出就给 display + aside**。

import { numberOrNull } from "./http.mjs";

const num = (v) => numberOrNull(v) ?? 0;
const round = (v, d = 2) => Number(Number(v).toFixed(d));

export function yuan(v) {
  const n = numberOrNull(v);
  if (n === null) return "";
  if (n === 0) return "¥0";
  if (Math.abs(n) < 0.01) return `¥${n.toFixed(4)}`;
  return `¥${round(n, 2)}`;
}

export function tokensText(v) {
  const n = numberOrNull(v);
  if (n === null) return "";
  if (n >= 1e8) return `${round(n / 1e8, 2)} 亿`;
  if (n >= 1e4) return `${round(n / 1e4, 1)} 万`;
  return String(Math.round(n));
}

/** deepFind 的轻量版：在对象树里找第一个命中的键（用于形状不稳定的管理接口）。 */
function pick(node, keys, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return undefined;
  for (const key of keys) {
    const v = node[key];
    if (v !== undefined && v !== null) return v;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      const found = pick(v, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function boolOf(v) {
  if (v === true || v === 1 || v === "true" || v === "enabled") return true;
  return false;
}

/** 序列 → 今天的 token 汇总（上游单位是 kToken，值已是千 token 数）。 */
export function sumSeries(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let input = 0;
  let output = 0;
  let cached = 0;
  let points = 0;
  const models = [];
  for (const row of list) {
    const i = num(row?.input);
    const o = num(row?.output);
    const c = num(row?.cached);
    input += i;
    output += o;
    cached += c;
    points += num(row?.points);
    if (i || o) models.push({ name: String(row?.model ?? "unknown"), input: i, output: o, cached: c });
  }
  models.sort((a, b) => b.input + b.output - (a.input + a.output));
  return { input, output, cached, points, total: input + output, models };
}

/** Key 限额：{daily_quota, monthly_quota, total_quota} 三个可带 {enabled, limit, alert_threshold}（limit 单位=元）。 */
export function readKeyQuota(data) {
  const src = data && typeof data === "object" ? (data.data ?? data) : undefined;
  if (!src || typeof src !== "object") return undefined;
  const read = (keys) => {
    for (const key of keys) {
      const node = src[key];
      if (node && typeof node === "object") {
        return {
          enabled: boolOf(node.enabled),
          limit: numberOrNull(node.limit ?? node.quota ?? node.max),
          alertThreshold: numberOrNull(node.alert_threshold ?? node.alertThreshold),
        };
      }
      if (node !== undefined && node !== null && typeof node !== "object") {
        return { enabled: boolOf(node), limit: numberOrNull(node), alertThreshold: null };
      }
    }
    return undefined;
  };
  const daily = read(["daily_quota", "dailyQuota", "day_quota"]);
  const monthly = read(["monthly_quota", "monthlyQuota", "month_quota"]);
  const total = read(["total_quota", "totalQuota", "quota"]);
  if (!daily && !monthly && !total) return undefined;
  return { daily, monthly, total };
}

/**
 * 资源包单位换算：七牛 billing respack/list 返回 `respack_unit: "k/tokens"`，
 * 数值（total_amount/used_amount）以千 token 计；buildUsage 统一按 token 展示，
 * 所以这里 ×1000。其它单位（m/tokens、裸 tokens）按各自倍数换。
 */
function respackScale(unit) {
  const u = String(unit || "").toLowerCase();
  if (/(^|\/)k(\/|$)|千/.test(u)) return 1000;
  if (/(^|\/)m(\/|$)|百万/.test(u)) return 1_000_000;
  return 1;
}

/** 资源包：上游字段不稳定，用 pick 兜（总量/已用/到期/名称/单位）。 */
export function readRespack(data) {
  const src = data && typeof data === "object" ? (data.data ?? data) : undefined;
  const list = Array.isArray(src) ? src : Array.isArray(src?.list) ? src.list : Array.isArray(src?.items) ? src.items : undefined;
  if (!list || !list.length) return undefined;
  const rows = list
    .map((it) => {
      // 七牛真实字段：total_amount / used_amount（单位 k/tokens）；旧字段一并兼容。
      const totalRaw = numberOrNull(pick(it, ["total_amount", "totalAmount", "total", "amount", "grant_total", "size"]));
      const usedRaw = numberOrNull(pick(it, ["used_amount", "usedAmount", "used", "consume", "consumed", "usage"]));
      const scale = respackScale(pick(it, ["respack_unit", "unit", "unit_type"]));
      const total = totalRaw === null ? null : totalRaw * scale;
      const used = usedRaw === null ? null : usedRaw * scale;
      const expire = pick(it, ["effective_end", "expire_at", "expired_at", "end_time", "expire_time", "deadline"]);
      // status: 2=生效中（七牛）；已过期/已用尽的包不该占用主窗口。
      const status = pick(it, ["status"]);
      return {
        name: String(pick(it, ["respack_name", "name", "title", "product_name", "type"]) ?? "资源包"),
        total,
        used,
        expireAt: expire === undefined ? undefined : normalizeTime(expire),
        active: status === undefined ? true : Number(status) === 2 || status === "2" || status === "active" || status === "valid",
      };
    })
    .filter((r) => r.active && Number.isFinite(r.total) && r.total > 0);
  if (!rows.length) return undefined;
  // 先按「剩余量」降序：把真正还能用的包顶到第一位，而不是只按总量。
  const restOf = (r) => (Number.isFinite(r.used) ? r.total - r.used : r.total);
  rows.sort((a, b) => restOf(b) - restOf(a));
  const top = rows[0];
  // 把同一账号下所有生效包的剩余额度汇总，供 buildUsage 展示总量。
  const totalRest = rows.reduce((sum, r) => sum + restOf(r), 0);
  const totalUsed = rows.reduce((sum, r) => sum + (Number.isFinite(r.used) ? r.used : 0), 0);
  return { ...top, aggregated: rows.length > 1, packCount: rows.length, totalRest, totalUsed, allTotal: rows.reduce((sum, r) => sum + r.total, 0) };
}

function normalizeTime(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 1e9) return asNum > 1e11 ? asNum : asNum * 1000;
  }
  return undefined;
}

/**
 * 当日 TPD 估算（七牛控制台不给这个数，而它是唯一真会拦死人的窗口 —— 429
 * "UID rate limit reached for TPD" 按账号的日 token 量计）。
 *
 * 口径（都是实测得出的保守值）：
 *   · 上游序列的单位是 kToken（normalizeUsageSeries 的 input/output 已是「千 token」数），
 *     ×1000 换回 token（与 buildUsage 第 5 类窗口同一口径）。
 *   · 分母：Key 限额接口的 limit 单位是**元**，换不成 token；所以 TPD 窗口默认**没有
 *     真实分母**，只报已用量 + display，不冒充 used 百分比。真有官方分母（未来上游
 *     若给）再补 limit。
 *   · days=1 的序列正好覆盖「本地日界（+08）0 点 → 现在」，与上游 TPD 的日界一致。
 *
 * @returns {{used:number, input:number, output:number, cached:number, models:number} | undefined}
 *          没有当日数据时返回 undefined（调用方决定要不要出窗口）。
 */
export function estimateTpd(series) {
  const rows = Array.isArray(series) ? series : [];
  let input = 0;
  let output = 0;
  let cached = 0;
  let models = 0;
  for (const row of rows) {
    const i = num(row?.input);
    const o = num(row?.output);
    if (!i && !o) continue;
    input += i;
    output += o;
    cached += num(row?.cached);
    models += 1;
  }
  if (!input && !output) return undefined;
  return {
    used: Math.round((input + output) * 1000),
    input: Math.round(input * 1000),
    output: Math.round(output * 1000),
    cached: Math.round(cached * 1000),
    models,
  };
}

/**
 * @param {object} input
 * @param {object} [input.account] 宿主账号（用于 plan/user 文案）
 * @param {object} [input.series]  normalizeUsageSeries 的结果
 * @param {object} [input.quota]   fetchKeyQuota 的 data
 * @param {object} [input.balance] normalizeBalance 的结果
 * @param {object} [input.respack] fetchRespackList 的 data
 * @param {object} [input.costDay] normalizeCost（当日）
 * @param {object} [input.costMonth] normalizeCost（当月）
 * @param {number} [input.now]
 */
export function buildUsage({ account, series, quota, balance, respack, costDay, costMonth, now = Date.now() } = {}) {
  const windows = [];
  const aksk = isAkskAccount(account);
  const sums = sumSeries(series);
  const q = readKeyQuota(quota);
  const pack = readRespack(respack);
  const day = costDay && Number.isFinite(costDay.totalFee) ? costDay : undefined;
  const month = costMonth && Number.isFinite(costMonth.totalFee) ? costMonth : undefined;

  // 1) 资源包：唯一有真实分母的额度，排在第一位
  if (pack && Number.isFinite(pack.used)) {
    // 多个包时统一用聚合口径：剩余=各包剩余之和，分母=各包总量之和，用量=已用之和。
    // 这样 amount/limit/used 三者自洽，不会出现「top 包 used=0 但旁边还有包用掉 99 万」的错位。
    const agg = pack.aggregated && Number.isFinite(pack.allTotal) && Number.isFinite(pack.totalRest) && Number.isFinite(pack.totalUsed);
    const total = agg ? pack.allTotal : pack.total;
    const usedTokens = agg ? pack.totalUsed : pack.used;
    const rest = agg ? pack.totalRest : Math.max(0, pack.total - pack.used);
    const label = agg ? `${pack.name} 等 ${pack.packCount} 个资源包` : pack.name;
    windows.push({
      name: label,
      used: Math.round((usedTokens / total) * 100),
      amount: rest,
      limit: total,
      unit: "tokens",
      display: `${tokensText(rest)} tokens 可用`,
      ...(pack.expireAt ? { resetsAt: pack.expireAt } : {}),
    });
  } else if (pack) {
    windows.push({ name: pack.name, used: 0, aside: true, display: `额度 ${tokensText(pack.total)} tokens（已用未知）`, unit: "tokens" });
  }

  // 2) Key 限额（limit 是金额，单位元）
  const pushQuota = (node, name) => {
    if (!node || !node.enabled || !Number.isFinite(node.limit) || node.limit <= 0) return;
    const spent = day && Number.isFinite(day.totalFee) ? day.totalFee : undefined;
    if (spent === undefined) {
      windows.push({ name, used: 0, aside: true, display: `上限 ${yuan(node.limit)}（已用未知）`, unit: "元" });
      return;
    }
    windows.push({ name, used: Math.min(100, Math.round((spent / node.limit) * 100)), amount: round(Math.max(0, node.limit - spent), 4), limit: node.limit, unit: "元" });
  };
  if (q) {
    pushQuota(q.daily, "Key 日限额");
    pushQuota(q.monthly, "Key 月限额");
  }

  // 3) 余额（只有 AK/SK 账号才查得到）
  // 现金余额为 0 绝不能写成 used:100/remaining:0 —— magpie 会据此判定账号额度耗尽、
  // 拒绝调度模型。七牛新用户赠送的是 token 资源包（见上面的 pack），现金余额本就是 0，
  // 所以余额窗口一律 aside:true，只展示不参与路由；真正决定能否调用的是资源包窗口。
  if (balance && Number.isFinite(balance.available)) {
    if (balance.available <= 0) {
      const hint = pack ? "（token 资源包可正常调用）" : "（请充值或领资源包）";
      windows.push({ name: "现金余额", used: 0, aside: true, amount: balance.available, unit: "元", display: `${yuan(balance.available)}${hint}` });
    } else {
      windows.push({ name: "现金余额", used: 0, aside: true, amount: balance.available, display: yuan(balance.available), unit: "元" });
    }
    if (Number.isFinite(balance.unpaid) && balance.unpaid > 0) {
      windows.push({ name: "待付金额", used: 0, aside: true, amount: balance.unpaid, display: `${yuan(balance.unpaid)} 待付`, unit: "元" });
    }
  }

  // 4) 花费（费用接口，5–15 分钟延迟 → 一律 aside）
  if (day) windows.push({ name: "今日花费", used: 0, aside: true, amount: day.totalFee, display: yuan(day.totalFee), unit: "元" });
  if (month) windows.push({ name: "本月花费", used: 0, aside: true, amount: month.totalFee, display: yuan(month.totalFee), unit: "元" });

  // 5) 今日 token（没有分母，只报数）
  if (sums.total > 0) {
    const cached = sums.cached > 0 ? `（缓存命中 ${tokensText(sums.cached)}）` : "";
    windows.push({ name: "今日 tokens", used: 0, aside: true, amount: sums.total * 1000, display: `输入 ${tokensText(sums.input * 1000)} / 输出 ${tokensText(sums.output * 1000)}${cached}`, unit: "tokens" });
  } else if (q || day || pack || balance) {
    windows.push({ name: "今日 tokens", used: 0, aside: true, display: "上游没返回今天的用量", unit: "tokens" });
  }

  // 5b) 今日 TPD（429 "rate limit reached for TPD" 的那个窗口）。
  // 有已用量就独立出窗口顶到前面 —— 用户看得见「今天已经烧了多少」，才知道 429 从哪来。
  const tpd = estimateTpd(series);
  if (tpd) {
    const cachedNote = tpd.cached > 0 ? `（含缓存 ${tokensText(tpd.cached)}）` : "";
    windows.unshift({
      name: "今日 TPD",
      used: 0,
      aside: true,
      amount: tpd.used,
      display: `已用 ${tokensText(tpd.used)} tokens${cachedNote}；上游不公布日上限，429 TPD 即到达。重置于下一个 +08 零点`,
      unit: "tokens",
    });
  }

  // 6) 啥都没拿到：给一句人话，别让面板空着
  if (!windows.length) {
    windows.push({
      name: "用量",
      used: 0,
      aside: true,
      display: aksk ? "上游没有返回用量" : "sk- Key 只能查询 token 序列，余额需要 AK/SK 登录",
      unit: "",
    });
  }

  const plan = pack ? `资源包 · ${pack.name}` : aksk ? "按量付费 · AK/SK" : "按量付费 · sk- Key";
  // label 由 account-name.mjs 统一解析（宿主别名优先），比裸 email 好认
  const user = account?.label || (balance && balance.email) || account?.email || account?.accountId || "";
  const out = { plan, windows };
  if (user) out.user = user;
  if (balance && Number.isFinite(balance.available)) out.balance = balance.available;
  if (Number.isFinite(now)) out.fetchedAt = now;
  return out;
}

/** 一个账号拿不到任何用量时的错误形态（signIn 只允许宿主规定的那三个值）。 */
export function usageError(message, { signIn, detail } = {}) {
  const out = { error: String(message || "查询用量失败"), windows: [] };
  if (signIn === "expired" || signIn === "kept" || signIn === "renewed") out.signIn = signIn;
  if (detail) out.detail = String(detail).slice(0, 300);
  return out;
}

export function isAkskAccount(account) {
  return Boolean(account && typeof account === "object" && account.accessKey && account.secretKey);
}

/** 余额是否见底（402 前置判断与面板告警共用）。 */
export function isLowBalance(balance, threshold = 1) {
  return Boolean(balance && Number.isFinite(balance.available) && balance.available <= threshold);
}

export function hasAnyUsage(usage) {
  return Boolean(usage && Array.isArray(usage.windows) && usage.windows.length && !usage.error);
}

export { pick as pickDeep };
