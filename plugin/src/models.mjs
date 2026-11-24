// src/models.mjs — 模型表合成：静态目录（catalog.mjs，A4 实测产出）+ 在线 /v1/models 校正。
//
// 两条消费路径必须产出**同一种条目形状**（都过 modelEntry）：
//   · config 钩子读顶层平字段：id name status rate cost limit reasoning tool_call attachment modalities
//   · provider.models 钩子读 capabilities 与 api
// 少一个字段 magpie 的路由/用量就会算错，所以集中在这一处生成，别处不许手拼。
//
// 上游 GET /v1/models 的事实（research/upstream-probe.md §1/§2）：
//   · 匿名 200；带任何 Bearer（哪怕已失效）→ 401。所以 provider.models 走三段回退：
//     带 key → 401/403 去 Authorization 重试一次 → 回落静态表。
//   · 字段只有 id/object/created/owned_by/context_length/max_tokens/service_status，
//     没有模态/价格/工具能力 → 能力一律取 catalog.mjs。
//   · context_length 与 max_tokens 都可能是 0（= 未声明），0 必须回落到 catalog 值，绝不写 0。
//   · service_status ∈ {available, unavailable}；unavailable 4 条 → status:"deprecated"。

import { CATALOG, DOC_ALIASES, DEFAULT_LIMITS, FREE_IDS, HIDDEN_IDS, NO_TOOL_IDS, REASONING_IDS, VISION_IDS, catalogEntry } from "./catalog.mjs";
import { ANTHROPIC_VERSION, BYPASS_ANTHROPIC_ORIGIN, BYPASS_ANTHROPIC_PATH, INFER_BASE, MODELS_PATH, SDK, SDK_ANTHROPIC } from "./config.mjs";

export const MODELS_URL = `${INFER_BASE}${MODELS_PATH}`;

/** /v1/models 里没有、走 bypass 通路的原厂 Claude。默认不进表，options.claudeBypass 打开才进。 */
export const EXTRA_CATALOG = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6（原厂透传）", context: 200_000, output: 32_000, vision: true, reasoning: true, free: false, rate: 1, toolCall: true, protocol: "anthropic", note: "bypass-only" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6（原厂透传）", context: 200_000, output: 64_000, vision: true, reasoning: true, free: false, rate: 1, toolCall: true, protocol: "anthropic", note: "bypass-only" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5（原厂透传）", context: 200_000, output: 64_000, vision: true, reasoning: true, free: false, rate: 1, toolCall: true, protocol: "anthropic", note: "bypass-only" },
];

const EXTRA_BY_ID = new Map(EXTRA_CATALOG.map((e) => [e.id, e]));

function chatUrl() {
  return `${INFER_BASE}/chat/completions`;
}

function bypassUrl() {
  return `${BYPASS_ANTHROPIC_ORIGIN}${BYPASS_ANTHROPIC_PATH}`;
}

/**
 * 目录条目 → magpie 的 Model 形状。
 * @param {string} id 上游模型 id
 * @param {object} [e] 目录条目；不传则查 catalog，再查 Claude 透传表，都没有 = 未知 id（保守形状）
 */
export function modelEntry(id, e) {
  const entry = e || catalogEntry(id) || EXTRA_BY_ID.get(id);
  const known = Boolean(entry);
  const vision = known ? Boolean(entry.vision) : VISION_IDS.has(id);
  const reasoning = known ? Boolean(entry.reasoning) : REASONING_IDS.has(id);
  const toolCall = known ? Boolean(entry.toolCall) : !NO_TOOL_IDS.has(id);
  const context = known && Number.isFinite(entry.context) && entry.context > 0 ? entry.context : DEFAULT_LIMITS.context;
  const rawOutput = known && Number.isFinite(entry.output) && entry.output > 0 ? entry.output : DEFAULT_LIMITS.output;
  // 上游有 6 条 max_tokens=0（回退值可能超过真实上限），还有 1 条 max_tokens 大于 context_length
  // （meituan/longcat-flash-lite：320000 > 256000）→ 输出上限一律压到不超过上下文窗口。
  const output = Math.min(rawOutput, context);
  const free = known ? Boolean(entry.free) : FREE_IDS.has(id);
  const rate = known && Number.isFinite(entry.rate) ? entry.rate : free ? 0 : 1;
  const anthropic = Boolean(known && entry.protocol === "anthropic");
  // catalog 用 note 里的 `in:audio` / `in:file` 标记「输入支持音频 / 文档」，别从 vision 硬推
  const note = known && typeof entry.note === "string" ? entry.note : "";
  const audio = /in:audio/.test(note);
  const pdf = /in:file|in:pdf/.test(note);
  const status = !known ? "active" : HIDDEN_IDS.has(id) ? "deprecated" : entry.status || "active";
  const inputModalities = ["text"];
  if (vision) inputModalities.push("image");
  if (audio) inputModalities.push("audio");
  if (pdf) inputModalities.push("file");
  return {
    id,
    name: known ? entry.name : id,
    status,
    free,
    rate,
    // 七牛价格以账户折扣后的 元/千token 为准，宿主没有对应的绝对单位约定，
    // 因此 cost 写 0 表示「上游没给」，相对排序交给 rate，真实花费交给 auth.usage 的窗口。
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output },
    reasoning,
    attachment: vision,
    tool_call: toolCall,
    modalities: { input: inputModalities, output: ["text"] },
    api: { id, url: anthropic ? bypassUrl() : chatUrl(), npm: anthropic ? SDK_ANTHROPIC : SDK },
    headers: anthropic ? { "anthropic-version": ANTHROPIC_VERSION } : {},
    capabilities: {
      temperature: true,
      reasoning,
      attachment: vision,
      toolcall: toolCall,
      input: { text: true, image: vision, audio, video: false, pdf },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
  };
}

/** 静态表 = catalog 全量（含 4 条 deprecated，宿主自己隐藏）；claudeBypass 为真时追加 3 条原厂 Claude。 */
export function staticModelTable(options = {}) {
  const table = {};
  for (const entry of CATALOG) table[entry.id] = modelEntry(entry.id, entry);
  if (options.claudeBypass) for (const entry of EXTRA_CATALOG) table[entry.id] = modelEntry(entry.id, entry);
  return table;
}

export function activeCount(table) {
  let n = 0;
  for (const id of Object.keys(table)) if (table[id].status !== "deprecated") n += 1;
  return n;
}

/**
 * 在线 /v1/models 的响应 → 表。结构不对就抛，让上层回落静态表。
 * 能力/价格取 catalog，limit 与可用性取在线值（在线新模型没目录条目 → 保守形状）。
 */
export function parseLiveModels(json, options = {}) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null;
  if (!list || !list.length) throw new Error("models: 响应里没有非空的 data 数组");
  const table = {};
  for (const item of list) {
    const id = typeof item?.id === "string" && item.id ? item.id : undefined;
    if (!id) continue;
    const base = catalogEntry(id) || EXTRA_BY_ID.get(id);
    const merged = {
      ...(base || {}),
      id,
      name: base?.name || id,
      context: Number.isFinite(item.context_length) && item.context_length > 0 ? item.context_length : base?.context || DEFAULT_LIMITS.context,
      output: Number.isFinite(item.max_tokens) && item.max_tokens > 0 ? item.max_tokens : base?.output || DEFAULT_LIMITS.output,
      vision: base ? base.vision : VISION_IDS.has(id),
      reasoning: base ? base.reasoning : REASONING_IDS.has(id),
      free: base ? base.free : FREE_IDS.has(id),
      rate: base && Number.isFinite(base.rate) ? base.rate : 1,
      toolCall: base ? base.toolCall : !NO_TOOL_IDS.has(id),
      protocol: base?.protocol,
      note: base?.note || "live-only",
    };
    const made = modelEntry(id, merged);
    // 上游说不存在就一定不存在；上游说 available 也不许把目录里的 deprecated 翻上来
    const upstreamHidden = item.service_status !== undefined && item.service_status !== "available";
    made.status = upstreamHidden || HIDDEN_IDS.has(id) ? "deprecated" : "active";
    table[id] = made;
  }
  if (!Object.keys(table).length) throw new Error("models: 解析后表为空");
  if (options.claudeBypass) for (const entry of EXTRA_CATALOG) if (!table[entry.id]) table[entry.id] = modelEntry(entry.id, entry);
  return table;
}

/**
 * id 归一：大小写、空白、文档 model_alias。
 * 表里没有的一律原样放行 —— 上游刚上线的新模型不能被我们的目录卡住。
 */
export function resolveModelId(rawId) {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id) return id;
  if (catalogEntry(id) || EXTRA_BY_ID.has(id)) return id;
  // 必须 hasOwnProperty：裸 obj[id] 会让 "constructor" / "toString" 命中原型链，把函数当模型 id 发出去
  const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
  const direct = own(DOC_ALIASES, id) || own(DOC_ALIASES, id.toLowerCase());
  if (direct) return direct;
  const lower = id.toLowerCase();
  for (const entry of CATALOG) if (entry.id.toLowerCase() === lower) return entry.id;
  for (const from of Object.keys(DOC_ALIASES)) if (from.toLowerCase() === lower) return DOC_ALIASES[from];
  for (const entry of EXTRA_CATALOG) if (entry.id.toLowerCase() === lower) return entry.id;
  return id;
}

export { CATALOG, catalogEntry, DOC_ALIASES, DEFAULT_LIMITS, FREE_IDS, HIDDEN_IDS, NO_TOOL_IDS, REASONING_IDS, VISION_IDS };
