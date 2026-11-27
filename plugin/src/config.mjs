// src/config.mjs — 七牛云 AI 常量表。
// 硬规矩：这个文件不许 import 任何东西（方便单测），不许发请求，不许读凭据。
// 改这里任何值，都要同步 README.md / plugin/README.md / CONTRACT.md。

export const PROVIDER = "qiniu-ai";
export const PROVIDER_NAME = "七牛云 Qiniu AI";
export const VERSION = "1.4.0";

// ---- 上游端点 ---------------------------------------------------------------
// 注意：INFER_BASE 自带 /v1。Anthropic 官方 SDK 的 base_url 惯例是不带 /v1
// （填 https://api.qnaigc.com，SDK 自己拼 /v1/messages），而 @ai-sdk/openai-compatible
// 是会拼 /chat/completions 的。两处假设不同，所以 loader 的 fetch 里统一归一，
// 任何改动都要同时看 src/relay.mjs 的 target 计算，否则会出现 /v1/v1/。
export const INFER_ORIGIN = "https://api.qnaigc.com";
export const INFER_BASE = `${INFER_ORIGIN}/v1`;
export const STAT_ORIGIN = INFER_ORIGIN; // /v3/stat/* 与 /v2/stat/* 同一域名
export const BILLING_ORIGIN = "https://api.qiniu.com"; // AK/SK 计费域
export const SDK = "@ai-sdk/openai-compatible";
export const SDK_ANTHROPIC = "@ai-sdk/anthropic";
export const ANTHROPIC_PATH = "/messages"; // 相对 INFER_BASE
export const ANTHROPIC_VERSION = "2023-06-01";

// ---- 路径常量 ---------------------------------------------------------------
export const MODELS_PATH = "/models"; // GET，无鉴权也返回 200
export const CHAT_PATH = "/chat/completions"; // POST
// 七牛独有的「原厂 Claude 透传」通路。它是**根路径下**的 /bypass/...，不在 /v1 下面，
// 所以 origin 用域名而不是 INFER_BASE（research/upstream-probe.md §4 实测：/v1 前缀会 404）。
export const BYPASS_ANTHROPIC_ORIGIN = INFER_ORIGIN;
export const BYPASS_ANTHROPIC_PATH = "/bypass/anthropic/v1/messages"; // 只吃 Bearer
export const USAGE_SERIES_PATH = "/v3/stat/usage"; // GET，Bearer，序列聚合
export const USAGE_COST_PATH = "/v3/stat/usage/apikey/cost"; // GET，Bearer 或 AK/SK
export const USAGE_COST_DETAIL_PATH = "/v3/stat/usage/apikey/cost-detail"; // GET，同上
export const EXPORT_LOG_PATH = "/v2/stat/export_log"; // GET，逐请求（含 cached_tokens）
export const KEY_QUOTA_PATH = "/v1/apikey/quota/"; // GET|PUT，AK/SK only
export const KEYS_CREATE_PATH = "/v1/apikeys"; // POST，AK/SK only
export const BALANCE_PATH = "/billing-api/v1/account/balance-overview"; // GET，AK/SK only
export const RESPACK_PATH = "/billing-api/v1/respack/list"; // GET，AK/SK only

// ---- 页面 ------------------------------------------------------------------
export const PORTAL_URL = "https://portal.qiniu.com/ai-inference/api-key";
export const MODELS_URL = "https://www.qiniu.com/ai/models";
export const MODELS_PLAZA_URL = MODELS_URL; // 能力与价格的真源（SSR JSON）
export const DOCS_URL = "https://developer.qiniu.com/aitokenapi";
export const REPO_URL = "https://github.com/cat-clash/magpie-qiniu";

// ---- 超时 ------------------------------------------------------------------
export const CHAT_TIMEOUT_MS = 600_000; // 图文/长上下文别学 curl 的 30s
export const IMAGE_TIMEOUT_MS = 900_000; // /v1/images/edits 文档建议读超时 >=15min
export const API_TIMEOUT_MS = 20_000; // 用量、校验这类小请求
export const VERIFY_TIMEOUT_MS = 15_000;
export const USAGE_TTL_MS = 30_000; // 配额读得勤会撞 5 QPS
export const KEY_CACHE_TTL_MS = 30 * 60_000;
export const REQUEST_LOG_CAP = 24;
export const USER_AGENT = `magpie-qiniu/${VERSION} (+${REPO_URL})`;

// ---- 单位换算 --------------------------------------------------------------
export const YUAN_PER_MILLION = 1_000_000; // 上游价格单位是 元/1000 token，×1000 变 元/百万
export const TOKENS_PER_YUAN_DIVISOR = 4; // 融合资源包基准价：deepseek-v3.1 输入 0.004 元/千 token

// ---- options 默认值（README「插件配置」一节必须与此一致）---------------------
export const DEFAULTS = {
  maxConcurrency: 4,
  usageCacheMs: USAGE_TTL_MS,
  liveModelList: true,
  modelListTtlMs: 60 * 60_000,
  promptCache: false, // 上游文档没有 prompt_cache_key 这个字段，默认不开
  quotaFailover: true, // 402 / 欠费403 改写为 429，让宿主切下一个账号
  webSearch: "auto", // auto | on | off；文档说 tools:{type:"web_search"} 被忽略，只透传不注入
  showCost: true,
  costSampleMs: 10 * 60_000, // 两次 cost-detail 取样的最小间隔
  keyLabel: "",
  stateDir: "",
  providerId: "", // 空 = qiniu-ai
  inferBase: "", // 空 = INFER_BASE
  claudeBypass: false, // 原厂 Claude 透传不在 /v1/models 里，默认不进模型表
  // 出站节奏闸（pacing.mjs）：按账号拉开最小间隔 + 抖动，先避开 TPM/RPM 窗口。
  // 0/0 = 完全直通；只关间隔就把 pacingMinMs 设 0。
  pacingMinMs: 800,
  pacingJitterMs: 400,
  // 账号级熔断（breaker.mjs）：连续失败到阈值就在本地停一段时间，别对着同一个账号连撞。
  // breakerThreshold 设 0 = 禁用熔断。
  breakerThreshold: 5,
  breakerCooldownMs: 30 * 60_000,
  retryOnNetworkError: true, // 传输层错误重试一次（请求没进上游，不涉及重复计费）
};

// ---- 边界（options 夹取用，README 参数表里的数字必须来自这里）----------------
export const CLAMP = {
  maxConcurrency: [1, 1000],
  usageCacheMs: [10_000, 600_000],
  modelListTtlMs: [60_000, 24 * 60 * 60_000],
  costSampleMs: [60_000, 60 * 60_000],
  providerIdPrefix: 40,
  pacingMinMs: [0, 60_000],
  pacingJitterMs: [0, 60_000],
  breakerThreshold: [0, 100],
  breakerCooldownMs: [60_000, 8 * 60 * 60_000],
};

// 供应商 id 必须只含小写字母、数字、连字符
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// 与 package.json 的 magpie.icon 逐字节一致（有测试断言），别在这里改图。
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiMwQjExMTYiLz48cGF0aCBkPSJNMTYgNDJhMTAgMTAgMCAwIDEgMS0yMCAxNCAxNCAwIDAgMSAyNy0zIDkgOSAwIDAgMSAzIDE3eiIgZmlsbD0iIzEyQjdGNSIvPjxjaXJjbGUgY3g9IjMwIiBjeT0iMjgiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IiMyQkQ5QzQiIHN0cm9rZS13aWR0aD0iNCIvPjxwYXRoIGQ9Ik0zNSAzM2w3IDgiIHN0cm9rZT0iIzJCRDlDNCIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=";
