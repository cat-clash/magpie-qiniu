# plugin/ —— 七牛云 Magpie 插件（`magpie-qiniu-lite`）

把七牛云 AI 推理网关（`https://api.qnaigc.com/v1`）接进 Magpie。能力说明、配置项、排错见[根 README](../README.md)；上游事实与模块归属见 [CONTRACT.md](../CONTRACT.md)。这里只记插件内部结构。

包名 `magpie-qiniu-lite`，provider id `qiniu-ai`，ESM `.mjs`，`engines.node >= 22`，**零运行时依赖**（只用 `node:crypto` 与 global fetch）。

## 钩子

| 钩子 | 作用 |
|---|---|
| `config` | 声明 `qiniu-ai` provider（`npm: "@ai-sdk/openai-compatible"`、`api` = 推理 Base）与**静态模型表**，未登录也要有内容 |
| `auth.methods` | 两种登录：`sk-` 正式 API Key 直填；七牛 AK/SK |
| `auth.loader` | 请求接管：归一 URL/method/body，注入 `prompt_cache_key`，按路由表转发上游 |
| `auth.usage` | 用量面板：token 序列 / 费用 / 余额 / 资源包 / Key 限额 |
| `auth.import` | 批量导入凭据（`parseCredentialBlob`），逐条回显、按 `uid` 去重 |
| `provider.models` | 每账号模型目录：拉 `GET /v1/models` 与静态表合并 |
| `diagnostics` | 只读快照，供排查（缓存条数、账号数、转发计数） |

**没有 `auth.refresh`** —— 七牛没有 token 续期概念：`sk-` 与 AK/SK 都不会过期，没有 refresh token 可刷。

**没有 `auth.checkin`** —— 七牛是按量付费的 API Key，上游不存在签到机制。本插件不实现、测试断言它不出现（[CONTRACT.md](../CONTRACT.md) §0）。

`auth` 的形状按宿主契约是 `{provider, methods[], loader, usage?, import?, importFrom, importFroms, icon?, maxConcurrency?}`，`refresh` / `checkin` 都是可选的，本插件两个都不给。

## 模块

| 文件 | 职责 |
|---|---|
| `index.mjs` | 钩子装配，无业务逻辑；导出 `QiniuPlugin` 与 `_internal = {CONFIG, AUTH, PROVIDER_HOOK, DIAGNOSTIC_KEYS, VERSION}` |
| `src/config.mjs` | 上游常量：`PROVIDER` / `INFER_BASE` / `STAT_ORIGIN` / `BILLING_ORIGIN` / `KEY_ORIGIN` / `SDK` / `ANTHROPIC_PATH` / `PORTAL_URL` / `MODELS_URL` / `DOCS_URL` / `ICON` / `K` / `DEFAULTS` / `USAGE_TTL_MS` / `CHAT_TIMEOUT_MS` / `USER_AGENT` / `REQUEST_LOG_CAP` / `CLAMP` |
| `src/http.mjs` | `ApiError` / `sleep` / `numberOrNull` / `jsonResponse` / `errorResponse` / **`redact()`** / `errorText` / `timeoutSignal` / `apiFetch` / `deepFind` / `parseJson` |
| `src/sign.mjs` | 七牛 AK/SK 签名：`signingString()` / `qiniuAuthHeader()` / `splitAksk()` |
| `src/catalog.mjs` | `CATALOG`（静态目录源条目）、`FREE_IDS`（reasoning / vision 兜底表）、`DEFAULT_LIMITS` |
| `src/models.mjs` | `toModelEntry` / `staticModelTable` / `resolveModelId` / `normalizeLiveModel` / `mergeLive` / `ALIASES` |
| `src/auth.mjs` | `keyDigest` / `accountLabelFor` / `parseKeyInput` / `makeKeyAccount` / `makeAkskAccount` / `accountOf` → `{mode:"key"|"aksk", apiKey, accessKey, secretKey, accountId, uid}` |
| `src/live-auth.mjs` | 账号最新快照 + 宿主 `getAuth` 句柄：`currentAuth` / `remember` / `latestOf` / `forget` / `resetLiveAuth` / `liveAuthCount` |
| `src/usage-api.mjs` | 上游用量族接口：`fetchUsageSeries` / `fetchApiKeyCost` / `fetchCostDetail` / `fetchExportLog` / `fetchKeyQuota` / `fetchBalanceOverview` / `fetchRespackList` / `createInferenceKey`；统一入参 `({account, signal, fetchImpl, origin, …})`，AK/SK 走 `sign` 回调 |
| `src/usage.mjs` | `buildUsage` / `usageError` / `isLowBalance` → 宿主的 usage 结构 |
| `src/relay.mjs` | 转发与有界缓存：`forwardChat` / `modelsResponse` / `setBounded` / `cacheSizes` / `invalidateKey` / `resetRelayState` |
| `src/cache-key.mjs` | `promptCacheKey(body)` / `digest(str, len)` |
| `src/bulk-import.mjs` | `parseCredentialBlob(texts)` / `mapLimit(items, n, fn)` |
| `tests/*.test.mjs` | `node:test` + `node:assert/strict`，**全部不联网** |

`forwardChat` 的签名（改动要同步测）：

```js
forwardChat({ account, path, body, method = "POST", headers, signal, opts, deps = {} }) -> Response
// deps.fetch 默认 globalThis.fetch；deps.onUnauthorized(account)；deps.log
```

## loader.fetch 路由（顺序即优先级）

1. 归一 URL / method / body（`Uint8Array` → TextDecoder，对象 → stringify，坏 JSON → `400 invalid_json`）。
2. `GET **/models` → 优先带上游 Bearer 转发，失败回退 `modelsResponse(staticModelTable())`。
3. `POST **/chat/completions` → `forwardChat`。
4. `POST **/messages` → `forwardChat`（Anthropic 兼容端点，见[事实边界](#事实边界)）。
5. 其它 → `501 not_implemented`。
6. 上游 `401` → 原样透传 + `x-magpie-sign-in: expired`。
7. `402` → 重写为中文可操作提示（type `insufficient_quota`）；先 `clone()` 再读正文，**不许消费掉原 body**。
8. `403` 且正文含 `is not available` / `model_not_found` / `模型不支持` / `price of the model is not set` → 改 **`404`** + `x-magpie-sign-in: kept`，type `not_available_error`。
9. 其余状态原样透传，**流式正文不改写**。
10. `getAuth()` 抛 → `401 sign_in_required` + `x-magpie-sign-in: expired`。

## 契约要点

- **模型表永远不能空**；五个模态键显式写布尔（省略 `image` ≠ 不支持图片）；`status:"deprecated"` 的模型宿主不显示。
- `provider.models` **失败时原样返回传进来的 `provider.models`**（引用不变），不要返回空对象或半张表。
- `max_tokens: 0` 表示上游没给 → 回退 `DEFAULT_LIMITS`，**绝不能把 `limit.output` 写成 0**。
- `loader` 必须返回 `{baseURL, apiKey:"", headers:{}, fetch(input,init)}`；改写流式正文时**必须删 `content-length` 与 `content-encoding`**。
- 失败语义：401 → 账号被标记；模型不可用要 **403 → 404**，**不要用 401**；`x-magpie-sign-in` 取 `expired | kept | renewed`，宿主转发前会去掉这个头。
- usage：**上游没给分母就不要写 `used`**（宿主明确说不要用 0 表示「不知道」，没 `used` 也没 `amount`/`limit` 时窗口只显示 `display`）；`aside:true` 的窗口不参与路由，真正会卡住账号的窗口不要设 `aside`；预付钱包用 `balance` 字段，不写 `used`/`limit`。
- `client.auth.set({path:{id}, body})` 是**全量替换**：只在 AK/SK 自动签发 `sk-` 时 best-effort 用一次，失败必须吞掉。
- 一切 options 走 `CLAMP` 夹紧；`providerId` 只允许 `[a-z0-9-]`；`baseUrl` 必须 https 且去尾斜杠。
- 一切 `sk-…` / `tk-…` / `AK:SK` / 签名过 `redact()` 才能进日志或错误文案，`extraHeaders` 的值同理。
- **不做签到、不做续期**：不引入 `checkin` / `refresh` 模块，也不许用定时器模拟。
- 改代码要 bump `package.json` 的 `version`，否则命中 Magpie 缓存。

## 事实边界

以下是**上游与宿主的现状**，不是本插件的选择，改动前请先更新 [research/](../research/)：

- `/v1/models` 的官方 schema 只声明 `id/object/created/owned_by` 四个字段，实际响应多出 `context_length`、`max_tokens`、`service_status` —— **文档落后于实现**，归一化要以实际响应为准，且要容忍上游哪天把字段收回去。
- `service_status` 目前只实测确认了 `available`；其余取值的含义未确认，一律按 `deprecated` 隐藏。
- 用量族在 **`/v3`** 与 **`/v2`**（`/v3/stat/usage`、`/v3/stat/usage/apikey/cost`、`/v2/stat/export_log`），**不在 `/v1` 下**；Key 与限额在 `/v1/apikey*`。别拼成一个 origin + 一条前缀。
- 余额数字的单位是 **元 × 1e8**（要除回去）；费用接口返回**原始标准价格，不含资源包 / 折扣**，与财务中心账单不一致是正常的；**当天数据有延迟**（官方口径约 15 分钟）。
- `/v3/stat/usage` 同 IP **5 req/s**；`granularity=day` 跨度 ≤31 天、`hour` ≤7 天；`timezone` 必须是 IANA 名，默认 `Asia/Shanghai`；`cost-detail` 最大跨度 100 天，`grain` 只能 `day|month`；Key 限额写入后 0~30 秒才生效。
- `tk-` 临时 Key 不能调 `/v3/stat/*`（`401 temporary key is not allowed`）；用量与费用接口只认 `sk-` 正式 Key 或 AK/SK 签名。
- 订阅积分**没有开放接口**，面板里没有它。
- **Anthropic `/v1/messages`**：上游文档（`endpoints.md`、`anthropic-chat.md`、`claude-cache.md`）把它列为兼容接口，且示例用 `x-api-key` 而非 `Authorization: Bearer` 认证。本仓库 `research/` 里**还没有该端点的本机实测记录**，因此插件只做原样转发、不做协议改写，README 里也标注为「按上游文档支持」。一旦实测证伪，删掉路由第 4 条并同步两处文档。
- 上游另有一个海外端点 `https://api.modelink.ai`；本插件默认走国内 `api.qnaigc.com`，换端点请用 `baseUrl` option，不要改常量。

## 测试

```bash
node plugin/tests/smoke.mjs            # 装配自检（含「没有 checkin 钩子」断言）
node --test plugin/tests/*.test.mjs    # 单测
```

全部不联网：AK/SK 签名用自造的固定 AK/SK 与固定时间戳断言签名串；用量 / 余额 / 建 Key 接口用注入的 `fetchImpl`；转发用假的 `deps.fetch`。测试不会碰 `~/.config/magpie`。
