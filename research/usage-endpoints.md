# 七牛用量 / 费用 / 余额 / Key 限额接口（A3 · usage-api）

> 取证说明：本轮尝试联网核对官方文档失败 —— `https://developer.qiniu.com/aitokenapi/13174/usage-api` 返回 **HTTP 404**（开发者中心外壳页，无正文），`web_search` 60s 超时。
> 因此下表「URL 模板 / 方法」以 **CONTRACT.md §1（主控已从控制台抓取）** 为准，标 `已实测`；
> **query 字段名与响应字段名**属 `仅文档/推测`，代码里全部用「别名表 + `normalize*` 容错 + `EP.query`/`query` 覆盖钩子」兜住：主控接上真号跑一次，若上游 400，只改 `usageEndpoints().query` 或调用时传 `query:{...}`，不必动 fetch 逻辑。
> 时间一律带偏移的 RFC3399（默认 `Asia/Shanghai` → `+08:00`），`zoneOffsetMs()` 走 `Intl` 推算偏移，未知/坏时区回落 `+08:00`，**不依赖本机时区**。

## 一、逐端点

| # | URL 模板 | 方法 | 鉴权 | 参数与夹紧 | 响应关键字段（读取顺序） | 状态 | 失败态 |
|---|---|---|---|---|---|---|---|
| 1 | `https://api.qnaigc.com/v3/stat/usage` | GET | Bearer `sk-…`（`mode:"key"` 主路）；AK/SK 签名亦可 | `from`/`to`＝本地日界的 RFC3399；`granularity=day\|hour\|week\|month`；`timezone`。**内部夹紧**：`day≤31`、`hour≤7`、`week≤182`、`month≤366`（`GRANULARITY_MAX_DAYS`），`days` 非法→7、越界→截到上限并回 `{days,clampedDays}` | `data[]` 或 `data.usage/list/items/models`；行内 `model\|model_name\|name\|id`、`input_tokens\|prompt_tokens\|input`、`output_tokens\|completion_tokens\|output`、`cached_tokens\|cache_read_tokens`、`points\|total_points\|fee`、`series\|buckets\|list\|items`（桶内 `time\|date\|day\|timestamp`，数字按秒/毫秒自动识别） | URL 已实测；字段名仅文档 | 401 `auth_api_key_invalid`→`signIn:"expired"`；403 `Request not allowed`/`apikey monthly quota exceeded`→保留 `code`、**不设 signIn**；429 `UID rate limit reached for TPD (oversea) for UID`（同 IP 5 req/s，模块内 `MIN_REQUEST_INTERVAL_MS=210` 串行闸门） |
| 2 | `https://api.qnaigc.com/v3/stat/usage/apikey/cost` | GET | Bearer | `type=day\|week\|month`，枚举外值回落 `month`（回 `{type}`） | `{status,data}`；`total_fee\|fee\|amount`、`currency`、`list[]\|items[]` 含 `name/fee/items[{name,unit,usage,fee}]` → `normalizeCost()` | URL 已实测；字段名仅文档 | 同 #1；`{"status":false,"error":"…"}` 会抛错且 message 含原文 |
| 3 | `https://api.qnaigc.com/v3/stat/usage/cost-detail` | GET | Bearer | `start_date`/`end_date`（接受 `YYYY-MM-DD`、Date、毫秒；缺省取最近 ≤7 天）、`granularity=day\|hour\|month`。跨度超上限时**保 end 截 start**（`hour` 再压到 7 天），回 `{startDate,endDate,clamped}` | 同 #2 结构（`normalizeCost()` 可直接复用） | URL 已实测；字段名仅文档 | 同 #1 |
| 4 | `https://api.qnaigc.com/v2/stat/export_log` | GET | Bearer | `size` 夹紧 `1..500`（默认 100，非法→100）、`page≥1` | `data.list/items[]`：逐请求 `model`、`input_tokens`、`output_tokens`、`cached_tokens`、`points/fee`、`created_at` | URL 已实测（CONTRACT §1 `size=1..500`）；字段名仅文档 | 同 #1；此端点最重，**不要放进 usage 钩子** |
| 5 | `https://api.qnaigc.com/v1/apikey/quota/:api_key` | GET（PUT 本层不暴露） | `mode:"key"`→Bearer＋path 用 `account.apiKey`；`mode:"aksk"`→必须 `sign`，且需显式传 `apiKey` | path 参数 `encodeURIComponent`；无额外 query | 限额类字段（`rpm/rpd/tpm/tpd/monthly_quota/used`，原样返回 `data` 供主控取） | 仅文档 | 无 key→`code:"api_key_required"`（不设 signIn）；aksk 缺 `sign`→`sign_callback_missing`（**不发请求**）；上游若只认签名则 401/403，按 `code` 显示 |
| 6 | `POST https://api.qnaigc.com/v1/apikeys` | POST | **AK/SK 签名（必须 `sign`）** | body `{name}`（`name` 缺省 `"magpie-qiniu-lite"`，截 64 字符；可 `body` 合并） | `data.key\|api_key\|apikey\|token`（`deepFirstString` 深度≤4 查找）→ `{key, apiKeyMasked, data}`；拿不到 key 抛 `code:"key_missing"` | 仅文档 | `mode:"key"`→`aksk_required`；缺 `sign`→`sign_callback_missing`；两者都**不设 signIn** |
| 7 | `https://api.qiniu.com/billing-api/v1/account/balance-overview` | GET | **AK/SK 签名（必须 `sign`）**；`Content-Type` 为空 | 无必填 query | `available_balance`、`cash_balance`、`present_balance`、`credit_line`、`unpaid_balance`、`email`/`account_id`/`uid`、`currency`；**直接对象外壳**（无 `status`） | URL 已实测（控制台 XHR）；字段名仅文档 | 签名不符 401 通常 `code:"signatur_denied"` 一类→**不设 signIn**；aksk 缺 `sign`→`sign_callback_missing` |
| 8 | `https://api.qiniu.com/billing-api/v1/respack/list` | GET | **AK/SK 签名（必须 `sign`）** | 无必填 query | `data[]\|list[]\|respacks[]`：资源包 `name`、`status`、`total/expired/remaining`（同为 ×1e8 或 ×100，本层不猜单位，原样给主控） | URL 已实测；字段名仅文档 | 同 #7 |

外壳剥离规则（`unwrap()`）：`{status:true,data}`→`data`；`{status:false,…}`→抛错并带原 `error/message/code`；`{code:"0"|no_error|success|ok, data}`→`data`；只有 `code` 且非 ok 值→抛错；其余（billing 直接对象、数组、裸标量）原样返回。`normalize*` 也各自容错 `{status,data}` / `{data}` / 裸数组三种入参。

## 二、`normalizeBalance` 的单位结论依据

* CONTRACT.md §1 明确写「余额单位是元×1e8」，且实测控制台展示 `¥7067.67` ↔ 接口回 `available_balance: 706767000000`：**比值恰为 1e8**，故 `BALANCE_UNIT = 1e8`，`toYuan()` 做 `v/1e8` 后 `toFixed(4)` 归整（避免二进制浮点长尾）。
* 706767000000 / 1e8 = 7067.67 ✓（测试里同时钉了 500000000→5、206767000000→2067.67、1500000000→15、123456789→1.2346）。
* 缺失字段→`null`（区别于 0，UI 可显示「未知」而不是「¥0.00」）；`currency` 缺省 `"CNY"`。
* ⚠️ 资源包/订阅积分**不做**这个换算：`fetchRespackList` 原样返回，CONTRACT §1 也说「积分无开放接口」——本层完全不提供 `normalizeRespack` 之类的伪精度。

## 三、主控 usage 钩子的调用顺序（总请求数上限 ≤4）

```
1  fetchUsageSeries({granularity:"day", days:7})      // 必发：曲线 + 分模型 points
2  fetchApiKeyCost({type:"month"})                     // 必发：当月费用/积分口径
3  account.mode==="aksk" && sign
     → fetchBalanceOverview()                          // 选发：余额（欠费诊断关键）
4  account.mode==="aksk" && sign && 需要资源包
     → fetchRespackList()  ⊕  account.mode==="key" && 需要限额
     → fetchKeyQuota({apiKey})                          // 选发，二选一，别同时发
```

* **硬上限 4 个请求 / 每次 usage 刷新**；`fetchCostDetail`、`fetchExportLog`、`createInferenceKey` 只在用户点开「明细 / 逐请求 / 自动签发 Key」时发，绝不进钩子。
* 顺序即降级顺序：#1/#2 用 Bearer 一定可用；#3/#4 需要 AK/SK+`sign`，缺签名回调时**抛错但不设 `signIn`**，主控据此走「余额未知」而不是把账号标失效。
* 并发：`fetchUsageSeries`/`fetchApiKeyCost` 受同 IP 5 req/s 限制，模块内 `gate()` 已按 host 串行 + 210ms 间隔（仅在没有注入 `fetchImpl` 时生效，测试不受影响）。
* 401/`signIn:"expired"`：只在 #1/#2（Bearer 路径）里采信，用于写 `x-magpie-sign-in: expired`；#3/#4 的 401 是签名问题，`err.signIn` 为 `undefined`。

### 缓存策略建议

| 数据 | key | TTL | 说明 |
|---|---|---|---|
| usage 序列（day） | `usage:<keyDigest>:<granularity>:<bizDate>` | **30 s**（同一次面板打开内 5 s） | 按天分片缓存，只重取「今天」那一片；跨天 key 变→自动失效 |
| apiKeyCost（month） | `cost:<keyDigest>:month` | **60 s** | 月累计变化慢 |
| balance | `balance:<akDigest>` | **5 min** | 只读展示；余额 0 或 402/403 欠费类错误时缩到 **30 s** |
| respack / quota | `respack:<akDigest>` / `quota:<keyDigest>` | **10 min** | 变更极少 |
| export_log | `log:<keyDigest>:<page>` | **5 min**，最多缓存 3 页 | 分页打开时保留首页缓存 |

* 错误也缓存，但**只缓存 15 s**（防止上游 503「the price of the model is not set」被钉死）。
* 429 → 按 `err.retryAfterMs`（本层已从 `Retry-After` 解析）退避，退避期内直接吐旧缓存（stale-while-error），并停止 #3/#4 选发请求。
* 单飞（single-flight）：同一 key 的进行中请求复用 Promise，别做「刷新按钮连点」。
* 缓存里**不得存明文 key**：只存 `mask()` 后的指纹（前 6 后 4），与 `CONTRACT §6` 的 redact 规则一致；`createInferenceKey` 返回的明文 key 只走主控的 `setSecret` 一次性入仓。

## 四、给主控的接线片段

```js
import { usageEndpoints, fetchUsageSeries, fetchBalanceOverview } from "./usage-api.mjs";
import { qiniuAuthHeader } from "./sign.mjs";            // A2
const sign = (p) => qiniuAuthHeader(p);                   // 或直接 deps.sign
const EP = usageEndpoints({ inferOrigin: cfg.INFER_BASE, billingOrigin: cfg.BILLING_BASE });
const u = await fetchUsageSeries({ account, sign, fetchImpl, signal, days: 7 });
const b = await fetchBalanceOverview({ account, sign, fetchImpl, signal }).catch((e) => ({ err: e }));
```
