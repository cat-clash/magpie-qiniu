// index.mjs — 七牛云 AI（api.qnaigc.com）Magpie 插件入口。
//
// 入口约定（magpie 文档 /docs/zh/plugins，摘要见 CONTRACT.md §3）：
//   · 一个具名工厂函数，返回 hooks 对象；**导出的每个函数都会被当成插件调用**，
//     所以这里只导出工厂 + 一个非函数的 `_internal`（测试用）。
//   · 钩子只提供 config / auth / provider / diagnostics 四个，其余宿主能力不用。
//   · 没有签到：本插件不导出 checkin（用户明确要求，CONTRACT §0）。

import {
  CHAT_TIMEOUT_MS,
  CLAMP,
  DEFAULTS,
  ICON,
  INFER_BASE,
  MODELS_URL,
  PROVIDER,
  PROVIDER_ID_RE,
  PROVIDER_NAME,
  SDK,
  USAGE_TTL_MS,
  VERSION,
} from "./src/config.mjs";
import { apiFetch, errorText, isAbort, jsonResponse, numberOrNull, redact } from "./src/http.mjs";
import { activeCount, parseLiveModels, staticModelTable } from "./src/models.mjs";
import { accountKey, costStats, latestOf, liveAuthCount, pushRequest, remember, requestLogOf, setHostGetter, setUsageCache, usageCacheOf } from "./src/live-auth.mjs";
import { apiKeyOf, forwardChat, isChatPath, isModelsPath, modelsResponse, normalizeRequest, notImplemented, tailOf, targetOf } from "./src/relay.mjs";
import { akskLogin, keyOnlyLogin, looksApiKey } from "./src/auth.mjs";
import { parseCredentialBlob, mapLimit, dedupeKeyOf } from "./src/bulk-import.mjs";
import { buildUsage, hasAnyUsage, isAkskAccount, usageError } from "./src/usage.mjs";
import {
  createInferenceKey,
  fetchApiKeyCost,
  fetchBalanceOverview,
  fetchKeyQuota,
  fetchRespackList,
  fetchUsageSeries,
  normalizeBalance,
  normalizeCost,
  normalizeUsageSeries,
} from "./src/usage-api.mjs";
import { qiniuAuthHeader } from "./src/sign.mjs";
import { createPacing } from "./src/pacing.mjs";
import { createBreaker } from "./src/breaker.mjs";
import { createHealthStore } from "./src/health.mjs";
import { accountLabel } from "./src/account-name.mjs";
import { PORTAL_URL, REQUEST_LOG_CAP } from "./src/config.mjs";

// ---- options ---------------------------------------------------------------
function numOption(value, fallback, [min, max], { int = true } = {}) {
  const n = numberOrNull(value);
  if (n === null) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return int ? Math.trunc(clamped) : clamped;
}
function strOption(value, fallback, max = 400) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

/** options 全部在这里收口，README 的「插件配置」表必须与此一致。 */
export function readOptions(raw = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const providerId = strOption(o.providerId, DEFAULTS.providerId || PROVIDER, CLAMP.providerIdPrefix);
  return {
    providerId: PROVIDER_ID_RE.test(providerId) ? providerId : PROVIDER,
    inferBase: strOption(o.inferBase, DEFAULTS.inferBase || INFER_BASE).replace(/\/+$/, ""),
    maxConcurrency: numOption(o.maxConcurrency, DEFAULTS.maxConcurrency, CLAMP.maxConcurrency),
    usageCacheMs: numOption(o.usageCacheMs, DEFAULTS.usageCacheMs, CLAMP.usageCacheMs),
    liveModelList: o.liveModelList !== false,
    modelListTtlMs: numOption(o.modelListTtlMs, DEFAULTS.modelListTtlMs, CLAMP.modelListTtlMs),
    promptCache: o.promptCache === true,
    quotaFailover: o.quotaFailover !== false,
    showCost: o.showCost !== false,
    costSampleMs: numOption(o.costSampleMs, DEFAULTS.costSampleMs, CLAMP.costSampleMs),
    claudeBypass: o.claudeBypass === true,
    keyLabel: strOption(o.keyLabel, "", 40),
    stateDir: strOption(o.stateDir, "", 300),
    pacingMinMs: numOption(o.pacingMinMs, DEFAULTS.pacingMinMs, CLAMP.pacingMinMs),
    pacingJitterMs: numOption(o.pacingJitterMs, DEFAULTS.pacingJitterMs, CLAMP.pacingJitterMs),
    breakerThreshold: numOption(o.breakerThreshold, DEFAULTS.breakerThreshold, CLAMP.breakerThreshold),
    breakerCooldownMs: numOption(o.breakerCooldownMs, DEFAULTS.breakerCooldownMs, CLAMP.breakerCooldownMs),
    retryOnNetworkError: o.retryOnNetworkError !== false,
    // 七牛的 tools:{type:"web_search"} 会被上游忽略（只透传、不注入），这个键只作记录与未来开关
    webSearch: ["auto", "on", "off"].includes(String(o.webSearch || "")) ? String(o.webSearch) : DEFAULTS.webSearch,
  };
}

// ---- 在线模型表（进程内缓存，按账号隔离）------------------------------------
const liveCache = new Map(); // accountKey -> { at, table }

async function loadLiveTable({ auth, opts, signal, fetchImpl }) {
  const key = accountKey(auth) || "anon";
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < opts.modelListTtlMs) return hit.table;

  const authHeader = apiKeyOf(auth);
  const load = async (headers) => {
    const response = await apiFetch(MODELS_URL, { method: "GET", headers, timeoutMs: 15_000, signal, fetchImpl });
    if (!response.ok) throw Object.assign(new Error(`models HTTP ${response.status}`), { status: response.status });
    return parseLiveModels(await response.json(), { claudeBypass: opts.claudeBypass });
  };

  // 三段回退：带 Key → 401/403 去掉 Authorization 再来一次 → 回落静态表
  if (authHeader) {
    try {
      const table = await load({ authorization: `Bearer ${authHeader}` });
      liveCache.set(key, { at: Date.now(), table });
      return table;
    } catch (e) {
      if (![401, 403].includes(Number(e?.status))) {
        if (isAbort(e)) throw e;
      }
    }
  }
  try {
    const table = await load({});
    liveCache.set(key, { at: Date.now(), table });
    return table;
  } catch {
    return undefined;
  }
}

// ---- 用量 ------------------------------------------------------------------
async function loadUsage({ auth, opts, signal, fetchImpl }) {
  const cached = usageCacheOf(auth);
  if (cached && Date.now() - cached.at < opts.usageCacheMs) return cached.value;

  const account = auth || {};
  const aksk = isAkskAccount(auth) || isAkskAccount(auth?.metadata) ? { ...(auth?.metadata || {}), ...auth } : undefined;
  const apiKey = apiKeyOf(auth);
  const sign = qiniuAuthHeader;

  let series;
  let quota;
  let balance;
  let respack;
  let costDay;
  let costMonth;
  const errors = [];

  const tasks = [];
  if (apiKey || aksk) {
    tasks.push(
      fetchUsageSeries({ account: aksk ? { mode: "aksk", ...aksk } : { mode: "key", apiKey }, sign, fetchImpl, signal, days: 1 })
        .then((r) => {
          series = normalizeUsageSeries(r.data);
        })
        .catch((e) => errors.push(`用量序列：${errorText(e)}`)),
    );
  }
  if (apiKey) {
    tasks.push(
      fetchKeyQuota({ account: { mode: "key", apiKey }, apiKey, sign, fetchImpl, signal })
        .then((r) => {
          quota = r.data;
        })
        .catch((e) => errors.push(`Key 限额：${errorText(e)}`)),
    );
  }
  if (aksk) {
    const akAccount = { mode: "aksk", ...aksk };
    tasks.push(
      fetchBalanceOverview({ account: akAccount, sign, fetchImpl, signal })
        .then((r) => {
          balance = normalizeBalance(r?.data);
        })
        .catch((e) => errors.push(`余额：${errorText(e)}`)),
    );
    tasks.push(
      fetchRespackList({ account: akAccount, sign, fetchImpl, signal })
        .then((r) => {
          respack = r?.data;
        })
        .catch((e) => errors.push(`资源包：${errorText(e)}`)),
    );
  }
  if (opts.showCost && (apiKey || aksk)) {
    const acct = aksk ? { mode: "aksk", ...aksk } : { mode: "key", apiKey };
    tasks.push(
      fetchApiKeyCost({ account: acct, sign, fetchImpl, signal, type: "day" })
        .then((r) => {
          costDay = normalizeCost(r.data);
        })
        .catch((e) => errors.push(`费用：${errorText(e)}`)),
    );
    tasks.push(
      fetchApiKeyCost({ account: acct, sign, fetchImpl, signal, type: "month" })
        .then((r) => {
          costMonth = normalizeCost(r.data);
        })
        .catch((e) => errors.push(`费用：${errorText(e)}`)),
    );
  }

  await Promise.allSettled(tasks);
  const usage = buildUsage({
    // 账号显示名交给 account-name.mjs 统一解析（alias → email → accountId → uid → 脱敏 Key）。
    // 宿主设过的别名（magpie accounts alias）在这里第一次被真正用上。
    account: { ...(auth || {}), label: accountLabel(auth) },
    series,
    quota,
    balance: balance || undefined,
    respack,
    costDay,
    costMonth,
  });
  if (errors.length && !hasAnyUsage(usage)) {
    const failed = usageError(errors[0], {});
    failed.detail = errors.join("；").slice(0, 300);
    setUsageCache(auth, failed);
    return failed;
  }
  if (errors.length) usage.note = errors.join("；").slice(0, 200);
  setUsageCache(auth, usage);
  return usage;
}

// ---- 插件本体 ---------------------------------------------------------------
export const QiniuPlugin = async (ctx = {}, options = {}) => {
  const opts = readOptions(options);
  const provider = opts.providerId;
  const fetchImpl = undefined; // 用运行时自带 fetch
  // 出站两道本地闸，都按账号分桶：节奏（预防 TPM/RPM）+ 熔断（TPD/欠费止损）
  const pacing = createPacing({ minMs: opts.pacingMinMs, jitterMs: opts.pacingJitterMs });
  const breaker = createBreaker({ threshold: opts.breakerThreshold, cooldownMs: opts.breakerCooldownMs });
  // 模型健康快照：连续「模型级」失败（404 未标价 / 不在订阅组）就标 dead，models 钩子把它藏起来
  const health = createHealthStore();

  const config = async (cfg) => {
    if (!cfg || typeof cfg !== "object") return;
    cfg.provider = cfg.provider && typeof cfg.provider === "object" ? cfg.provider : {};
    const slot = (cfg.provider[provider] = cfg.provider[provider] && typeof cfg.provider[provider] === "object" ? cfg.provider[provider] : {});
    if (!slot.name) slot.name = PROVIDER_NAME;
    if (!slot.npm) slot.npm = SDK;
    if (!slot.api) slot.api = opts.inferBase;
    const table = staticModelTable({ claudeBypass: opts.claudeBypass });
    slot.models = { ...table, ...(slot.models || {}) };
  };

  const authorizeKey = async (inputs, { signal } = {}) => {
    const result = await keyOnlyLogin(
      {
        apiKey: inputs?.apiKey || inputs?.key || inputs?.password,
        keyLabel: inputs?.keyLabel || opts.keyLabel,
        label: inputs?.label,
      },
      { provider, inferOrigin: opts.inferBase, signal },
    );
    if (result.type !== "success") return { type: "failed", error: result.error };
    return { type: "success", key: result.apiKey, metadata: { ...result, apiKey: result.apiKey } };
  };

  const authorizeAksk = async (inputs, { signal } = {}) => {
    const result = await akskLogin(
      { accessKey: inputs?.accessKey || inputs?.ak, secretKey: inputs?.secretKey || inputs?.sk, keyLabel: inputs?.keyLabel || opts.keyLabel, label: inputs?.label },
      { provider, billingOrigin: undefined, signal },
    );
    if (result.type !== "success") return { type: "failed", error: result.error };
    return { type: "success", key: result.apiKey || "", metadata: { ...result } };
  };

  const pickAuth = (auth) => {
    const flat = { ...(auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}), ...(auth || {}) };
    if (!flat.apiKey && typeof flat.key === "string" && looksApiKey(flat.key)) flat.apiKey = flat.key;
    return flat;
  };

  const loader = async (getAuth) => ({
    baseURL: opts.inferBase,
    apiKey: "",
    headers: {},
    async fetch(input, init) {
      const { url, method, headers } = normalizeRequest(input, init);
      const tail = tailOf(url);

      // 1) 模型列表：本地回，不联网（reasoning/vision 等能力全在静态表里）
      if (method === "GET" && isModelsPath(tail)) {
        const table = staticModelTable({ claudeBypass: opts.claudeBypass });
        return modelsResponse(table);
      }

      // 2) 只代理 chat/messages；其余（embeddings 等）上游根本没有
      if (!isChatPath(tail) && !tail.includes("/messages")) return notImplemented(tail);

      let auth;
      try {
        auth = pickAuth(await getAuth());
      } catch {
        return jsonResponse({ error: { message: "账号凭据已失效，请重新登录七牛云", type: "authentication_error", code: "sign_in_required" } }, { status: 401, headers: { "x-magpie-sign-in": "expired" } });
      }
      const apiKey = apiKeyOf(auth);
      if (!apiKey) {
        return jsonResponse(
          {
            error: {
              message: auth?.accessKey
                ? "这个账号只有 AK/SK，没有可用于推理的 sk- Key：请在插件设置里重新登录以自动签发，或去控制台创建 Key 后改用 Key 登录"
                : "这个账号没有可用的 API Key，请重新登录",
              type: "authentication_error",
              code: "sign_in_required",
            },
          },
          { status: 401, headers: { "x-magpie-sign-in": "expired" } },
        );
      }

      remember(auth);
      setHostGetter(auth, getAuth);

      // 3) body 归一：可能是字符串、Uint8Array、也可能是已解析对象
      let body = init?.body ?? undefined;
      if (body && typeof body === "object" && !(body instanceof Uint8Array) && typeof body !== "string") {
        try {
          body = JSON.stringify(body);
        } catch {
          return jsonResponse({ error: { message: "请求体无法序列化", type: "invalid_request_error", code: "invalid_json" } }, { status: 400 });
        }
      }
      let requestedModel = "";
      if (typeof body === "string" && body) {
        const looksJson = /^\s*[[{]/.test(body);
        try {
          const parsed = JSON.parse(body);
          const model = typeof parsed?.model === "string" ? parsed.model : "";
          requestedModel = model;
          pushRequest(auth, { model, method, at: Date.now(), status: "sent" }, REQUEST_LOG_CAP);
        } catch {
          // 看着像 JSON 却解析不了：当场回 400，别让上游替我们报错（省一次往返，也让错误更准）
          if (looksJson) {
            return jsonResponse({ error: { message: "请求体不是合法 JSON", type: "invalid_request_error", code: "invalid_json" } }, { status: 400 });
          }
        }
      }

      const target = targetOf(tail, opts.inferBase);
      const response = await forwardChat({
        url: target,
        method,
        headers,
        body,
        apiKey,
        signal: init?.signal,
        timeoutMs: CHAT_TIMEOUT_MS,
        fetchImpl,
        options: {
          quotaFailover: opts.quotaFailover,
          accountKey: accountKey(auth),
          pacing,
          breaker,
          retryOnNetworkError: opts.retryOnNetworkError,
          // 模型级可用性 → 健康快照（账号级失败不进这里，避免把好模型标死）
          onModelResult: (ok, status, code) => {
            if (!requestedModel) return;
            health.record(requestedModel, ok, { status, code });
          },
        },
      });
      return response;
    },
  });

  const auth = {
    provider,
    icon: ICON,
    maxConcurrency: opts.maxConcurrency,
    methods: [
      {
        type: "api",
        label: "七牛云 API Key",
        labels: { en: "Qiniu API key" },
        placeholder: "sk-…",
        prompts: [
          {
            type: "password",
            key: "apiKey",
            message: `粘贴七牛云 API Key（${PORTAL_URL}）`,
            placeholder: "sk-…",
            validate: (v) => (looksApiKey(v) ? undefined : "应以 sk- 或 tk- 开头"),
          },
          { type: "text", key: "keyLabel", message: "备注（可留空）", placeholder: "例如 主力 / 备用" },
        ],
        authorize: authorizeKey,
      },
      {
        type: "api",
        label: "七牛云 AK/SK（可查余额）",
        labels: { en: "Qiniu AK/SK" },
        placeholder: "AccessKey / SecretKey",
        prompts: [
          {
            type: "text",
            key: "accessKey",
            message: "第 1 步 / 共 2 步：AccessKey（AK，访问密钥 ID）",
            placeholder: "控制台 → 密钥管理 → AccessKey",
          },
          {
            type: "password",
            key: "secretKey",
            message: "第 2 步 / 共 2 步：SecretKey（SK，私密密钥，创建时只显示一次）",
            placeholder: "控制台 → 密钥管理 → SecretKey（创建时复制的那串）",
          },
          { type: "text", key: "keyLabel", message: "备注（可留空）", placeholder: "例如 主账号" },
        ],
        authorize: authorizeAksk,
      },
    ],
    loader,

    async usage(getAuth) {
      let authValue;
      try {
        authValue = pickAuth(await getAuth());
      } catch {
        return usageError("账号凭据已失效，请重新登录七牛云", { signIn: "expired" });
      }
      if (!authValue || !(authValue.apiKey || (authValue.accessKey && authValue.secretKey))) {
        return usageError("这个账号没有凭据，请重新登录", { signIn: "expired" });
      }
      try {
        return await loadUsage({ auth: authValue, opts });
      } catch (e) {
        const text = errorText(e);
        const expired = /401|invalid api key|auth/i.test(text);
        return usageError(`查询用量失败：${text}`, expired ? { signIn: "expired" } : {});
      }
    },

    /** 批量导入：每行一条凭据，逐个校验；返回宿主登录对象数组（失败项带 error）。 */
    async import(texts) {
      const chunks = Array.isArray(texts) ? texts : [texts];
      const parsed = parseCredentialBlob(chunks.filter(Boolean).join("\n"), { max: 200 });
      const results = await mapLimit(parsed.entries, Math.min(4, opts.maxConcurrency), async (entry) => {
        const result = entry.apiKey
          ? await keyOnlyLogin({ apiKey: entry.apiKey, label: entry.label, keyLabel: entry.label }, { provider, inferOrigin: opts.inferBase })
          : await akskLogin({ accessKey: entry.accessKey, secretKey: entry.secretKey, label: entry.label, keyLabel: entry.label }, { provider });
        if (result.type !== "success") return { type: "failed", error: `${entry.label ? entry.label + "：" : ""}${result.error}` };
        return result;
      });
      for (const err of parsed.errors) results.push({ type: "failed", error: `第 ${err.line} 行：${err.reason}` });
      const seen = new Set();
      return results.filter((r) => {
        if (r.type !== "success") return true;
        const fp = dedupeKeyOf(r);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      });
    },
    importFrom: "粘贴多行七牛云凭据：每行一把 sk- Key，或 AccessKey:SecretKey（也可整段 JSON）",
    importFroms: { en: "One Qiniu credential per line: sk- key, or AccessKey:SecretKey (JSON array also works)" },
  };

  const providerHook = {
    id: provider,
    async models(current, ctx = {}) {
      const base = current?.models && typeof current.models === "object" ? current.models : staticModelTable({ claudeBypass: opts.claudeBypass });
      let table = base;
      if (opts.liveModelList) {
        try {
          const authValue = pickAuth(ctx?.auth || {});
          const live = await loadLiveTable({ auth: authValue, opts, signal: ctx?.signal });
          // 在线表优先，但把磁盘上用户自己改过的条目保留下来（disabled 之类）
          if (live) table = { ...base, ...live };
        } catch {
          table = base;
        }
      }
      // 健康快照：连续失败到阈值的模型标 deprecated，宿主不再路由它。
      // 构造新对象，别原地改缓存表（缓存要保留上游的原始状态）。
      const dead = table && health.snapshot().dead;
      if (dead && dead.length) {
        const out = { ...table };
        for (const id of dead) if (out[id]) out[id] = { ...out[id], status: "deprecated" };
        return out;
      }
      return table;
    },
  };

  const diagnostics = {
    snapshot() {
      const table = staticModelTable({ claudeBypass: opts.claudeBypass });
      return {
        provider,
        version: VERSION,
        options: { ...opts },
        models: { total: Object.keys(table).length, active: activeCount(table) },
        live: { accounts: liveAuthCount(), cached: liveCache.size },
        cost: costStats,
        pacing: pacing.stats(),
        breaker: breaker.stats(),
        modelHealth: health.snapshot(),
        requestLog: requestLogOf,
        redact,
      };
    },
  };

  return { config, auth, provider: providerHook, diagnostics };
};

// 测试入口：导出非函数的对象，宿主不会把它当插件调用（导出函数才会）。
export const _internal = {
  readOptions,
  loadLiveTable,
  loadUsage,
  liveCache,
  VERSION,
  USAGE_TTL_MS,
};
