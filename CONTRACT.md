# CONTRACT · magpie-qiniu-lite（七牛云 Magpie 插件）

> 这是本工程唯一的契约真源。所有子智能体**只能改自己认领的文件**；
> 需要动别人的文件时，把改动写进最终回复，由主控落地。

## 0. 硬约束

- **不做每日签到**：不出现 `checkin` 钩子、不出现签到模块。测试要断言这一点。
- 零运行时依赖：只用 Node/Bun 内置（`node:crypto`、global fetch）。`package.json` 无 `dependencies`。
- ESM `.mjs`，`engines.node >= 22`。宿主是 magpie 内置 Bun 1.x。
- 不打印 secret：一切 `sk-…`/`tk-…`/AK:SK/签名必须过 `redact()`。
- provider id = `qiniu-ai`（`qiniu` 被 `github:tk103331/magpie-qiniu-plugin` 占用了，见 `research/provider-ids.md`）。
- npm 包名 = `magpie-qiniu-lite`；仓库名 = `magpie-qiniu-installer`。
- 全中文正文；双语只出现在宿主 UI 字段（`labels:{en}`、`importFroms`）。
- 不许碰 `~/.config/magpie`（真配置）；一切验证用临时 HOME 或 `MAGPIE_BIN` 桩。

## 1. 上游事实（已实测，2026-11-25）

| 项 | 值 |
| --- | --- |
| 推理 Base | `https://api.qnaigc.com/v1`（Chat Completions，OpenAI 兼容） |
| Anthropic | `https://api.qnaigc.com/v1/messages`（待 A1 复核可用性） |
| 用量 | `https://api.qnaigc.com/v3/stat/usage`（**注意：v3，不在 /v1 下**） |
| 费用 | `…/v3/stat/usage/apikey/cost?type=day\|week\|month`、`…/cost-detail` |
| 逐请求 | `…/v2/stat/export_log?size=1..500&page=N` |
| Key 限额 | `GET\|PUT https://api.qnaigc.com/v1/apikey/quota/:api_key`（AK/SK 签名） |
| 建 Key | `POST https://api.qnaigc.com/v1/apikeys`（AK/SK 签名，返回 `key`） |
| 余额 | `GET https://api.qiniu.com/billing-api/v1/account/balance-overview`（AK/SK 签名） |
| 资源包 | `GET https://api.qiniu.com/billing-api/v1/respack/list`（AK/SK 签名） |
| 控制台 | `https://portal.qiniu.com/ai-inference/api-key` |
| 模型广场 | `https://www.qiniu.com/ai/models` |
| 文档 | `https://developer.qiniu.com/aitokenapi` |

- 无鉴权错误体：`{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}`（HTTP 401）。
- `GET /v1/models` 返回 `{object:"list",data:[{id,object,created,owned_by,context_length,max_tokens,service_status}]}`。
  - `max_tokens` 可能为 `0`（表示未给）→ 必须回退默认，**绝不能把 `limit.output` 写成 0**。
  - `service_status` 已知值 `available`；其余取值待 A1 确认（未知值一律 `status:"deprecated"` 隐藏）。
- 常见错误文案（用于分档，来自 A2/A3 文档摘录）：402 余额/资源包不足；403 `Request not allowed`（欠费）/`apikey monthly quota exceeded`/`model … is not available in your assigned model groups`；503 `the price of the model is not set`；429 `UID rate limit reached for TPD (oversea) for UID`/RPM/TPM。
- `/v3/stat/usage` 限流：同 IP 5 req/s；`granularity=day` 跨度 ≤31 天，`hour` ≤7 天；`timezone` 需 IANA 名（默认 `Asia/Shanghai`）。
- 订阅积分**没有开放接口**，余额单位是**元 × 1e8**（要除回去）。

## 2. Magpie 钩子契约（来自 usemagpie.ai/docs/zh/plugins）

- `config(cfg)`：填 `cfg.provider["qiniu-ai"] = {name, npm:"@ai-sdk/openai-compatible", api:INFER_BASE, models}`；模型条目顶层平字段 `{id,name,limit:{context,output},reasoning,tool_call,modalities:{input,output},cost:{input,output,cache:{read,write}},rate,free?,status,attachment?}`。
- `provider.models(provider,{auth})`：返回 `{id:Model}`；条目要带 `capabilities` + `api`。失败时**原样返回 `provider.models`**（引用不变）。
- `auth` = `{provider, methods[], loader(getAuth,provider), usage?, import?, importFrom, importFroms, icon?, maxConcurrency?}`；**无 refresh、无 checkin**。
- `auth.usage(getAuth,provider)` → `{plan,user,until,renew,balance,error,windows[],resets{},signIn}`；上游没给分母就不要写 `used`；`aside:true` 不参与路由。
- `loader` → `{baseURL, apiKey:"", headers:{}, fetch(input,init)}`；改写流式正文必须删 `content-length`/`content-encoding`。
- 失败语义：401 → 账号被标记；模型不可用要 **403/404**，不要用 401；响应头 `x-magpie-sign-in: expired|kept|renewed`。
- 账号存储：`getAuth()` 拿到 `{type:"api", key, metadata?, accountId?, access?, refresh?, expires?}`；`client.auth.set({path:{id},body})` 是**全量替换**，只在 AK/SK→自动签发 Key 时 best-effort 用一次，失败要吞掉。

## 3. 模块与导出（谁写谁负责，签名不许改）

```
plugin/index.mjs        export const QiniuPlugin = async (ctx={}, options={}) => ({config,auth,provider,diagnostics})
                        export const _internal = { readOptions, loadLiveTable, loadUsage, liveCache, VERSION, USAGE_TTL_MS }
                        [主控]
plugin/src/config.mjs   PROVIDER PROVIDER_NAME INFER_BASE STAT_ORIGIN BILLING_ORIGIN KEY_ORIGIN SDK ANTHROPIC_PATH
                        PORTAL_URL MODELS_URL DOCS_URL ICON K DEFAULTS USAGE_TTL_MS CHAT_TIMEOUT_MS USER_AGENT
                        REQUEST_LOG_CAP CLAMP
                        [主控]
plugin/src/http.mjs     ApiError sleep numberOrNull jsonResponse errorResponse redact errorText
                        timeoutSignal apiFetch deepFind parseJson  [主控]
plugin/src/cache-key.mjs promptCacheKey(body) keyFingerprint(v) contentToText(content)  [主控]
plugin/src/sign.mjs     signingString({method,url,contentType,body,headers,accessKey})
                        qiniuAuthHeader({method,url,contentType,body,headers,accessKey,secretKey})
                        splitAksk(value) -> {ok,accessKey,secretKey,error}
                        [A2]
plugin/src/catalog.mjs  CATALOG(源条目数组) FREE_IDS(reasoning/vision 兜底表) DEFAULT_LIMITS
                        [A4]
plugin/src/models.mjs   modelEntry(id,e) staticModelTable(options) resolveModelId(raw) parseLiveModels(json,options)
                        activeCount(table) MODELS_URL EXTRA_CATALOG，再导出 catalog 的 DOC_ALIASES
                        [主控]
plugin/src/auth.mjs     looksApiKey looksAkskPair accountLabelOf uidOf successAuth(fields)
                        verifyApiKey({apiKey,inferOrigin}) verifyAksk(...) keyOnlyLogin(inputs,ctx)
                        akskLogin(inputs,ctx) login applyCredentialPatch isUsableAuth
                        [主控]
plugin/src/live-auth.mjs accountKey remember latestOf setHostGetter currentAuth forget resetLiveAuth liveAuthCount [主控]
plugin/src/usage-api.mjs fetchUsageSeries fetchApiKeyCost fetchCostDetail fetchExportLog fetchKeyQuota
                        fetchBalanceOverview fetchRespackList createInferenceKey
                        统一入参 ({ account, signal, fetchImpl, origin, ... })，Aksk 走 sign 回调
                        [A3]
plugin/src/usage.mjs    yuan tokensText sumSeries readKeyQuota readRespack
                        buildUsage({account,series,quota,balance,respack,costDay,costMonth,now})
                        usageError(message,{signIn,detail}) isAkskAccount isLowBalance hasAnyUsage pickDeep
                        [主控]
plugin/src/relay.mjs    normalizeRequest(input,init) tailOf(url) isChatPath isModelsPath targetOf(tail,base)
                        filterHeaders(headers) modelsResponse(table) notImplemented(path)
                        classifyResponse(status,text,options) forwardChat({...}) apiKeyOf(auth)
                        [主控]
plugin/src/bulk-import.mjs parseCredentialBlob(text,{max}) -> {entries,errors} mapLimit(items,limit,fn)
                        dedupeKeyOf isValidProviderId   [主控]
plugin/tests/*.test.mjs node:test + node:assert/strict，全部不联网
                        [A8: smoke.mjs, auth, relay, cache-key, bulk-import, http, plugin-shape]
                        [A2: sign.test.mjs] [A3: usage-api.test.mjs] [A4: catalog.test.mjs, models.test.mjs]
install.ps1 install.sh tests/e2e/*            [A5]
.github/workflows/ci.yml _tools/verify.mjs    [A7]
README.md plugin/README.md CONTRIBUTING.md SECURITY.md .gitignore .gitattributes
.github/ISSUE_TEMPLATE/* docs/*.md            [A6]
```

`forwardChat` 精确签名（以实现为准，relay.test.mjs 按此断言）：

```js
forwardChat({ url, method, headers, body, apiKey, signal, timeoutMs, fetchImpl, options }) -> Response
// fetchImpl 默认 globalThis.fetch；apiKey 直接传字符串（不从 account 取）；2xx 原样回 Response，非 2xx 按 classifyResponse 重建
// 注意：normalizeRequest 只产出 {url, method, headers}，body 由调用方（index.mjs loader）归一；
//       classifyResponse 的 401 missing_credential 分支返回对象不含 signIn 字段。
```

## 4. options（`plugins.json` 里 `options`，全部夹紧）

| key | 类型 | 默认 | 夹紧 |
| --- | --- | --- | --- |
| `providerId` | string | `qiniu-ai` | 只允许 `[a-z0-9-]` |
| `baseUrl` | string | `https://api.qnaigc.com/v1` | 必须 https，去尾斜杠 |
| `maxConcurrency` | number | 4 | 1..1000 |
| `usageCacheMs` | number | 30000 | ≥5000 |
| `chatTimeoutMs` | number | 600000 | ≥30000 |
| `promptCache` | boolean | true | — |
| `autoCreateKey` | boolean | true | AK/SK 账号自动签发 sk- |
| `showAllModels` | boolean | true | `provider.models` 拉 /v1/models |
| `modelOverrides` | object | `{}` | id → 局部字段 |
| `extraHeaders` | object | `{}` | 值过 `redact()` 才可日志 |
| `dailyUsageDays` | number | 7 | 1..31 |

## 5. loader.fetch 路由与错误分档（主控实现，A8 断言）

1. 归一 URL/method/body（`Uint8Array`→TextDecoder，对象→stringify，坏 JSON→400 `invalid_json`）。
2. `GET **/models` → 优先转发上游（带 Bearer），失败回退 `modelsResponse(staticModelTable())`。
3. `POST **/chat/completions` → `forwardChat`。
4. `POST **/messages` → `forwardChat`（Anthropic 兼容，若 A1 证实可用）。
5. 其它 → 501 `not_implemented`。
6. 401 上游 → 原样透传 + 头 `x-magpie-sign-in: expired`。
7. 402 → 重写为中文可操作提示（type `insufficient_quota`，先 `clone()` 再读正文，不许消费掉原 body）。
8. 403 且正文含 `is not available`/`model_not_found`/`模型不支持`/`price of the model is not set` → 改 **404** + `x-magpie-sign-in: kept`，type `not_available_error`。
9. 其余状态原样透传，流式正文不改写。
10. `getAuth()` 抛 → 401 `sign_in_required` + `x-magpie-sign-in: expired`。

## 6. 安装器契约（A5）

参数两端等价：`--login/-Login`、`--uninstall/-Uninstall`、`--force/-Force`、`--dry-run/-DryRun`、`--yes/-y/-Yes`、`--no-color/-NoColor`、`--help/-h/-Help`。
退出码：`0` 成功/取消/`--help`；`1` 找不到 magpie 或未知参数；`2` 插件源码缺失/包名不符/`plugin add` 失败；`3` 装后 `plugin list` 复核没有 `qiniu-ai`。
`install.ps1`：`#Requires -Version 5.1`，**禁用 `??` 与三元**，UTF-8 **带 BOM**；`Invoke-Magpie` 必须 `2>$null`（magpie.com 把启动日志写 stderr）。
`install.sh`：`set -uo pipefail`（**不加 -e**）；用 sed 抽 package.json 字段，不依赖 jq/node。
两端日志前缀一致：`==> ` Step、`[ok] `、`[!] `、`[x] `、三空格 Dim；`-NoColor` 或非 tty 置空。
e2e 用 `tests/e2e/fake-magpie.mjs` 桩（`plugin add|list|rm|login`，状态落 `$FAKE_MAGPIE_STATE`）+ `installer.test.mjs`（node:test，spawn 真脚本，`MAGPIE_BIN` 指桩）。
桩的 `plugin list` 输出必须含字面量 `qiniu-ai`。

## 7. 交付验收（主控最后逐条跑）

```bash
node --check plugin/index.mjs && node --check plugin/src/*.mjs
node plugin/tests/smoke.mjs
node --test plugin/tests/*.test.mjs
node --test tests/e2e/installer.test.mjs      # 需要 node；本机用 bun 跑等价命令
bash -n install.sh && bash install.sh --help && MAGPIE_BIN=/bin/true bash install.sh --dry-run
pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('./install.ps1',[ref]$null,[ref]$null)"
```
本机没有 node/npm，只有 `C:\Users\c\AppData\Local\Temp\bun-node-a7733435c\bun.exe`（1.4.5）→ 测试用 `bun test` 与 `bun run` 双跑，脚本里**不要依赖 `node --test` 才有的行为**（`node:test` + `node:assert/strict` 在 Bun 里可用）。
