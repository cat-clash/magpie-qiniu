// src/score.mjs — 模型评分与推荐：把 catalog.mjs 的 91 条按用途算成 0..1 的分，给出 top N。
//
// 为什么要有它：目录里 91 个模型，用户手上只有「编码 / 长文 / 视觉 / 便宜」四类诉求，
// 而 91 条的字段差异又很细（context 从 40000 到 1048576、output 从 4096 到 1048576、
// 只有 5 条 free、toolCall=false 只有 1 条）。肉眼比不出来，所以把「选哪个」压成一次排序。
//
// 本模块是**纯逻辑**：零 import（DEFAULT_LIMITS 在本地复制一份，测试会与 catalog.mjs 交叉校验）、
// 无 IO、无网络、无 console。所有输入都用防脏值的读取器，所有输出都是有限数字或字符串。
//
// ── 四个维度（都是 0..1，越大越好）────────────────────────────────────────
//
//   context    上下文窗口。对数归一：log1p(context) / log1p(cap)，cap 默认 1_000_000。
//              为什么用对数：context 的实际差距是「能不能塞下」，1M 对 128K 是 8 倍但感受是
//              「都能塞」；线性归一会让 1M 一家独大，对数归一让 128K→256K 也有可见提升。
//              1_048_576（Kimi 系）略微超过 cap，归一后 >1，一律夹到 1.0。
//
//   output    输出上限。同一套对数归一，cap 默认 128_000。output ≥ 128K 的条目全部饱和到 1.0，
//              这是故意的：128K 输出已经是「一次写完一整个文件」的档位，再大对用户无差别。
//
//   price      价格。七牛只给相对价：catalog 的 rate 只有 0 / 1 两个取值，0 是折扣位不是价格，
//              唯一可信的免费信号是 free 位（FREE_IDS，5 条）。所以这里只做二值：
//              free===true → 1；否则 rate<=0 → 1（主控把 rate=0 当「未给折扣」）；其余 → 0。
//              不做假精确：没有单价就不编连续价格曲线。
//
//   capability 能力，按 profile 换算法（见下）。这是唯一「看用途」的维度。
//
// ── profile 权重（每个 profile 四个权重和为 1）────────────────────────────
//
//   balanced      { context: .30, output: .15, price: .25, capability: .30 }  ← 通用默认
//   coding        { context: .20, output: .15, price: .10, capability: .55 }  ← 工具调用+推理
//   long-context  { context: .45, output: .30, price: .05, capability: .20 }  ← 窗口与输出
//   vision        { context: .15, output: .10, price: .05, capability: .70 }  ← 视觉位
//   cheap         { context: .15, output: .05, price: .70, capability: .10 }  ← 免费优先
//
//   capability 按 profile 的算法：
//     coding      toolCall ? 0.6 : 0.3（不支持工具调用直接砍半）+ reasoning ? 0.4 : 0 → 0.3..1.0
//                 理由：编码场景里工具调用是硬门槛（不能改文件就只能给建议），推理位是加分项。
//     vision      vision ? 1 : 0.1。给 0.1 而不是 0，是为了让非视觉模型仍能靠上下文进榜尾，
//                 但永远排不进 vision 榜前 — 权重 .70 下非视觉上限 0.37，视觉下限 0.70，不会翻转。
//     long-context 0.6*contextScore + 0.4*outputScore（窗口比输出更决定「能不能一次性读进来」）。
//     cheap       priceScore（只看 free / rate）。
//     balanced    0.35*toolCall + 0.35*reasoning + 0.15*vision + 0.15*(context+output)/2。
//
// ── 脏数据兜底（上游实测：6 条 max_tokens=0、1 条 context_length=0）──
//
//   注意 CATALOG 里这些已经换成了兜底值并用 note 打了标记（upstream-0 / ctx-0），所以静态目录本身
//   没有 0；但在线 /v1/models 的原始条目、手写条目、以后新加的条目都可能带 0、负数、NaN 或缺失。
//   这些一律按 DEFAULT_LIMITS（128K / 8192）兜底 ——
//   与 models.mjs 对宿主的口径一致（上游 0 表示「未公布」，不是「不许输出」）。
//   兜底不静默：parts.notes 里留一行说明（如「context 脏值 0 → 兜底 131072」），
//   explain() 会把它打出来，排序结果因此可复现、可解释。
//
// 排序稳定：score 保留 6 位小数（避免浮点尾差把同分拆开），同分按 id 升序（ASCII 比较，
// 不用 localeCompare —— 结果不随宿主语言环境变）。

/** 支持的用途档位。未知值一律抛 TypeError，不做静默回退（静默回退会让人拿着 balanced 的结果以为是 coding 的）。 */
export const PROFILES = ["balanced", "coding", "long-context", "vision", "cheap"];

/**
 * 脏值兜底（本地复制自 catalog.mjs 的 DEFAULT_LIMITS）。
 * 本模块零 import，所以不能直接引用；plugin/tests/score.test.mjs 会断言两处相等，
 * 改一处忘改另一处测试会红。
 */
export const DEFAULT_LIMITS = Object.freeze({ context: 128 * 1024, output: 8192 });

/** 各 profile 的四维权重（每行和为 1，测试会断言）。 */
export const PROFILE_WEIGHTS = Object.freeze({
  balanced: Object.freeze({ context: 0.3, output: 0.15, price: 0.25, capability: 0.3 }),
  coding: Object.freeze({ context: 0.2, output: 0.15, price: 0.1, capability: 0.55 }),
  "long-context": Object.freeze({ context: 0.45, output: 0.3, price: 0.05, capability: 0.2 }),
  vision: Object.freeze({ context: 0.15, output: 0.1, price: 0.05, capability: 0.7 }),
  cheap: Object.freeze({ context: 0.15, output: 0.05, price: 0.7, capability: 0.1 }),
});

/** 归一化基准：1M 上下文 / 128K 输出。 */
export const CAPS = Object.freeze({ context: 1_000_000, output: 128_000 });

/** 一句话说明每个 profile 适合什么，CLI 末尾打印它。 */
export const PROFILE_HINTS = Object.freeze({
  balanced: "通用默认：四维均衡，不知道选什么就用它",
  coding: "写代码：优先工具调用（能改文件）+ 推理位，价格只占 10%",
  "long-context": "长文/整仓阅读：上下文与输出上限占 75%，便宜与否几乎不看",
  vision: "看图：vision 位占 70%，非视觉模型会被压到 0.37 以下",
  cheap: "省钱：免费位 + 价格占 80%，免费模型必然排在所有付费模型之前",
});

// ── 内部工具 ────────────────────────────────────────────────────────────────

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** 6 位小数：让「同分」真的是同分，排序不会因浮点尾差抖动。 */
function round6(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e6) / 1e6;
}

/** 读 limit 字段：正有限数才算有效，其余（0 / 负 / NaN / 缺失 / 字符串垃圾）走兜底。 */
function readLimit(model, field) {
  const fallback = DEFAULT_LIMITS[field];
  const raw = model && typeof model === "object" ? model[field] : undefined;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n <= 0) {
    const shown = raw === undefined ? "缺失" : String(raw);
    return { value: fallback, fallback: true, note: `${field} 脏值 ${shown} → 兜底 ${fallback}` };
  }
  return { value: n, fallback: false, note: "" };
}

/** 布尔位：只认 true，其余（"true" / 1 / 缺失）都当 false —— 与 models.mjs 的 Boolean() 语义区分开。 */
function boolOf(model, field) {
  return Boolean(model && typeof model === "object" && model[field] === true);
}

function assertProfile(profile) {
  const p = profile === undefined || profile === null ? "balanced" : String(profile);
  if (!PROFILES.includes(p)) {
    throw new TypeError(`未知 profile：${p}（可选：${PROFILES.join(" / ")}）`);
  }
  return p;
}

/** 对数归一（cap 本身也防脏值）。 */
function logNorm(value, cap) {
  const c = Number(cap);
  const capN = Number.isFinite(c) && c > 0 ? c : 1;
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  const denom = Math.log1p(capN);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return clamp01(Math.log1p(v) / denom);
}

// ── 维度（0..1）─────────────────────────────────────────────────────────────

/**
 * 上下文窗口分：log1p(context) / log1p(cap)。
 * @param {object} model 目录条目（只用 model.context）
 * @param {number} [cap=1000000] 归一化上限；≥cap 一律 1.0
 */
export function contextScore(model, cap = CAPS.context) {
  const { value } = readLimit(model, "context");
  return round6(logNorm(value, cap));
}

/**
 * 输出上限分：log1p(output) / log1p(cap)。
 * @param {object} model 目录条目（只用 model.output）
 * @param {number} [cap=128000] 归一化上限；≥cap 一律 1.0
 */
export function outputScore(model, cap = CAPS.output) {
  const { value } = readLimit(model, "output");
  return round6(logNorm(value, cap));
}

/**
 * 价格分：free===true → 1；rate<=0 → 1（主控把 rate=0 当「未给折扣」，这里同样当免费位）；
 * 其余 → 0。七牛没有绝对单价，所以不做连续价格曲线。
 */
export function priceScore(model) {
  if (!model || typeof model !== "object") return 0;
  if (model.free === true) return 1;
  const rate = Number(model.rate);
  if (!Number.isFinite(rate)) return 0;
  return rate <= 0 ? 1 : 0;
}

/**
 * 能力分（看 profile 换算法，详见模块头注释）。
 * @param {object} model 目录条目
 * @param {string} profile balanced / coding / long-context / vision / cheap
 */
export function capabilityScore(model, profile = "balanced") {
  const p = assertProfile(profile);
  if (!model || typeof model !== "object") return 0;
  switch (p) {
    case "coding": {
      const tools = boolOf(model, "toolCall");
      const reason = boolOf(model, "reasoning");
      return round6(clamp01((tools ? 0.6 : 0.3) + (reason ? 0.4 : 0)));
    }
    case "vision":
      return boolOf(model, "vision") ? 1 : 0.1;
    case "long-context":
      return round6(clamp01(0.6 * contextScore(model) + 0.4 * outputScore(model)));
    case "cheap":
      return round6(priceScore(model));
    case "balanced":
    default: {
      const tools = boolOf(model, "toolCall") ? 1 : 0;
      const reason = boolOf(model, "reasoning") ? 1 : 0;
      const vision = boolOf(model, "vision") ? 1 : 0;
      const limits = (contextScore(model) + outputScore(model)) / 2;
      return round6(clamp01(0.35 * tools + 0.35 * reason + 0.15 * vision + 0.15 * limits));
    }
  }
}

// ── 打分 ────────────────────────────────────────────────────────────────────

/**
 * 单模型打分。
 * @returns {{id:string, score:number, parts:{context:number, output:number, price:number, capability:number, notes:string[]}}}
 *          parts 的四个维度都是 0..1；parts.notes 是兜底留痕（空数组 = 数据干净）。
 */
export function scoreModel(model, profile = "balanced") {
  const p = assertProfile(profile);
  const w = PROFILE_WEIGHTS[p];
  const ctx = readLimit(model, "context");
  const out = readLimit(model, "output");
  const parts = {
    context: contextScore(model),
    output: outputScore(model),
    price: priceScore(model),
    capability: capabilityScore(model, p),
  };
  const notes = [];
  if (ctx.fallback) notes.push(ctx.note);
  if (out.fallback) notes.push(out.note);
  const score = round6(
    w.context * parts.context + w.output * parts.output + w.price * parts.price + w.capability * parts.capability,
  );
  parts.notes = notes;
  const id = typeof model?.id === "string" ? model.id : "";
  return { id, score, parts };
}

/** 标签：给人看的短词，用来解释「为什么它在榜上」。 */
export function tagsOf(model) {
  if (!model || typeof model !== "object") return [];
  const tags = [];
  if (boolOf(model, "free") || Number(model.rate) <= 0) tags.push("free");
  if (boolOf(model, "vision")) tags.push("vision");
  if (boolOf(model, "reasoning")) tags.push("reasoning");
  tags.push(boolOf(model, "toolCall") ? "tools" : "no-tools");
  const ctx = readLimit(model, "context");
  if (ctx.value >= 1_000_000) tags.push("1M-ctx");
  if (ctx.fallback) tags.push("ctx-fallback");
  if (readLimit(model, "output").fallback) tags.push("out-fallback");
  if (typeof model.note === "string" && /status=unavailable/.test(model.note)) tags.push("deprecated");
  return tags;
}

/**
 * 排序推荐。
 * @param {object[]} models 目录条目数组（catalog.mjs 的 CATALOG 或任意子集）
 * @param {{profile?:string, limit?:number, exclude?:string[]|Set<string>}} [opts]
 *        exclude 默认用来传 health.snapshot().dead（宿主进程内存态，CLI 读不到，所以默认空）
 * @returns {{id:string,name:string,score:number,parts:object,tags:string[]}[]}
 *          按 score 降序、同分按 id 升序；limit<=0 或不传 = 全量。
 */
export function rankModels(models, { profile = "balanced", limit = 10, exclude = [] } = {}) {
  const p = assertProfile(profile);
  const list = Array.isArray(models) ? models : [];
  const skip = exclude instanceof Set ? exclude : new Set((Array.isArray(exclude) ? exclude : []).map((x) => String(x)));
  const rows = [];
  for (const model of list) {
    if (!model || typeof model !== "object") continue;
    const id = typeof model.id === "string" ? model.id : "";
    if (!id || skip.has(id)) continue;
    const { score, parts } = scoreModel(model, p);
    rows.push({
      id,
      name: typeof model.name === "string" && model.name ? model.name : id,
      score,
      parts,
      tags: tagsOf(model),
    });
  }
  rows.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return rows;
  return rows.slice(0, Math.trunc(n));
}

/**
 * 「为什么是这个分」：逐条给数字，CLI 打印它，人不信排序时用来对账。
 * @returns {string[]} 非空字符串数组；第一行是总分，之后每维一行，最后是兜底留痕（如果有）
 */
export function explain(model, profile = "balanced") {
  const p = assertProfile(profile);
  const w = PROFILE_WEIGHTS[p];
  const { id, score, parts } = scoreModel(model, p);
  const ctx = readLimit(model, "context");
  const out = readLimit(model, "output");
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const lines = [];
  lines.push(`总分 ${score.toFixed(4)}（profile=${p}，id=${id || "(空 id)"}）`);
  lines.push(
    `上下文 ${ctx.value} tokens → ${parts.context.toFixed(4)} × 权重 ${pct(w.context)} = ${(parts.context * w.context).toFixed(4)}`,
  );
  lines.push(
    `输出 ${out.value} tokens → ${parts.output.toFixed(4)} × 权重 ${pct(w.output)} = ${(parts.output * w.output).toFixed(4)}`,
  );
  lines.push(
    `价格 free=${boolOf(model, "free")} rate=${Number.isFinite(Number(model?.rate)) ? Number(model.rate) : "缺失"} → ` +
      `${parts.price.toFixed(4)} × 权重 ${pct(w.price)} = ${(parts.price * w.price).toFixed(4)}`,
  );
  const tools = boolOf(model, "toolCall");
  const reason = boolOf(model, "reasoning");
  const vision = boolOf(model, "vision");
  lines.push(
    `能力 toolCall=${tools} reasoning=${reason} vision=${vision} → ${parts.capability.toFixed(4)} × 权重 ${pct(w.capability)} = ${(
      parts.capability * w.capability
    ).toFixed(4)}`,
  );
  for (const note of parts.notes) lines.push(`兜底：${note}`);
  return lines;
}

/**
 * 一次看清五个 profile 各自的前 3 名（每档各 3 条，档内不重复）。
 * @returns {Record<string, {id:string,name:string,score:number}[]>}
 */
export function compareProfiles(models) {
  const out = {};
  for (const p of PROFILES) {
    out[p] = rankModels(models, { profile: p, limit: 3 }).map((r) => ({ id: r.id, name: r.name, score: r.score }));
  }
  return out;
}
