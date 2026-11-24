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

/** 资源包：上游字段不稳定，用 pick 兜（总量/已用/到期/名称）。 */
export function readRespack(data) {
  const src = data && typeof data === "object" ? (data.data ?? data) : undefined;
  const list = Array.isArray(src) ? src : Array.isArray(src?.list) ? src.list : Array.isArray(src?.items) ? src.items : undefined;
  if (!list || !list.length) return undefined;
  const rows = list
    .map((it) => {
      const total = numberOrNull(pick(it, ["total", "amount", "quota", "grant_total", "size"]));
      const used = numberOrNull(pick(it, ["used", "used_amount", "consume", "consumed", "usage"]));
      const expire = pick(it, ["expire_at", "expired_at", "end_time", "expire_time", "deadline"]);
      return {
        name: String(pick(it, ["name", "title", "product_name", "respack_name", "type"]) ?? "资源包"),
        total,
        used,
        expireAt: expire === undefined ? undefined : normalizeTime(expire),
      };
    })
    .filter((r) => Number.isFinite(r.total) && r.total > 0);
  if (!rows.length) return undefined;
  rows.sort((a, b) => (b.total || 0) - (a.total || 0));
  return rows[0];
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
    const rest = Math.max(0, pack.total - pack.used);
    windows.push({
      name: pack.name,
      used: Math.round((pack.used / pack.total) * 100),
      amount: rest,
      limit: pack.total,
      unit: "tokens",
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
  if (balance && Number.isFinite(balance.available)) {
    if (balance.available <= 0) {
      windows.push({ name: "账户余额", used: 100, amount: balance.available, unit: "元", display: `${yuan(balance.available)} 余额不足，请充值` });
    } else {
      windows.push({ name: "账户余额", used: 0, aside: true, amount: balance.available, display: yuan(balance.available), unit: "元" });
    }
    if (Number.isFinite(balance.unpaid) && balance.unpaid > 0) {
      windows.push({ name: "待付金额", used: 100, aside: true, amount: balance.unpaid, display: `${yuan(balance.unpaid)} 待付`, unit: "元" });
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
  const user = (balance && balance.email) || account?.email || account?.accountId || "";
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
