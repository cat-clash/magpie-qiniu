# 七牛 AK/SK 签名口径核对（A2 · sign）

抓取时间：2026-11-25（本机 bun 1.4.5，无 node）。作者：agent-6（sign 模块）。
产物：`plugin/src/sign.mjs`、`plugin/tests/sign.test.mjs`、本文件。

## 0. 依据 URL（逐条核对过正文）

| # | URL | 文中标注 | 对本次结论的作用 |
|---|-----|---------|------------------|
| A | https://developer.qiniu.com/kodo/1201/access-token | 管理凭证，更新于 2021-05-13 | 通用「Qiniu 签名」算法全文 + 黄金样例（Method 大小写敏感、`X-Qiniu-<key>` 规范化与 ASCII 升序、headers 后 `\n\n`、`application/octet-stream` 不签 body、urlsafe_base64 + `Qiniu <AK>:<sig>`） |
| B | https://developer.qiniu.com/aitokenapi/13405/set-api-key-limit-api | AK/SK 签名算法，更新于 2026-03-24 | `api.qnaigc.com` 的官方口径与**官方 Node 参考实现** `generateSigningString({method,path,query,host,contentType,headers,body})`；`GET/PUT /v1/apikey/quota/:api_key` |
| C | https://developer.qiniu.com/aitokenapi/13382/new-usage-api | AK/SK 签名实现参考，更新于 2026-07-29 | `GET /v3/stat/usage` 的官方示例 `path` **已含编码后 query**（`start=...T00:00:00%2B08:00`）；curl 同用 `%2B`；错误码 `invalid ak/sk sign` |
| D | https://developer.qiniu.com/aitokenapi/13392/new-batch-create-keys-api | 批量创建 Key，更新于 2026-03-24 | `POST /v1/apikeys` 走 AK/SK 签名；**签名有效期 15 分钟**；AK/SK 控制台 https://portal.qiniu.com/developer/user/key |
| — | https://developer.qiniu.com/kodo/1671/rest-auth | 302 → region-endpoint-fq | 该 id 不是签名文档（任务里给的这个链接失效） |
| — | https://developer.qiniu.com/aitokenapi/13392 | 404 | 必须带 slug 才能取到正文 |
| — | qiniu/go-sdk `auth/requests/auth.go`（raw.githubusercontent / jsdelivr）| 404 / GitHub API 403 | 未能抓 Go 源码，故 SDK 侧口径以文档 + CONTRACT 为准（见 §2 待复核） |

技能目录检查：本会话 catalog 里与「取文档」相关的只有 `autoglm-browser-agent`（浏览器自动化，重且不需要），其余为 Windows ACL / hindsight / office 类，均不匹配 → 按能力选择规则直接用 `web_fetch`，未加载技能。

## 1. 逐字规则（实现口径）

```
signingStr = <METHOD> + " " + <Path> + ("?" + <Query> 当 Query 非空)
           + "\nHost: " + <Host>
           + ("\nContent-Type: " + <Content-Type> 当已设置)
           + 对每个 X-Qiniu-* 头: "\n" + <规范化Key> + ": " + <Value>
           + "\n\n"
           + (<Body> 当已设置 Content-Type 且 Content-Type ≠ application/octet-stream 且不属于 §2 排除集)

sign        = hmac_sha1(key = AccessSecret, data = signingStr)
encodedSign = urlsafe_base64(sign)      // + → - ，/ → _ ，保留 = 填充
Authorization: Qiniu <AccessKey>:<encodedSign>
```

- A/B 原文逐字要点：「Method：HTTP 方法，大小写敏感」「Path：不含域名和查询参数」「Query：不包含开头的 `?`，仅在有值时才添加」「Host：请求域名，不含 scheme 和端口（本项目实现按 URL authority 原样，见 §3.3）」「Headers：仅 `X-Qiniu-` 前缀且 key 不可为空，`<key>` 按 ASCII 码升序排序」「在 headers 部分结束后追加两个连续的换行符 `\n\n`」「Body：仅当 Content-Type 不是 `application/octet-stream` 时才添加」。
- Key 规范化（A/B 同文）：`x-qiniu-date` → `X-Qiniu-Date`（首字母与 `-` 后字母大写，其余小写）。实现函数 `canonicalXQiniuKey`。
- A 的黄金样例（测试第 1 条逐字复现）：`MY_ACCESS_KEY` / `MY_SECRET_KEY`，`POST http://rs.qiniu.com/move/bmV3ZG9jczpmaW5kX21hbi50eHQ=/bmV3ZG9jczpmaW5kLm1hbi50eHQ=` → signingStr `"POST /move/…=/…=\nHost: rs.qiniu.com\n\n"`，hmac 十六进制 `d6e2efb9933a97aa02cd916a909ea8238a053154`。
- 时间窗：D 文「签名有效期为 15 分钟」。若带 `X-Qiniu-Date`，其值必须落在服务器 ±15 分钟内（辅助接口 13404 的 curl 示例亦带该头）。`nowXQiniuDate()` 产出 `YYYY-MM-DDTHH:mm:ssZ`（UTC 秒级）。

## 2. 三个必答结论

### 2.1 query 在 Path 同一行，不是独立一行（默认官方口径）

依据：B 的格式块 `<Method> <Path>[?Query]` 与「Query 不包含开头的 ?，仅在有值时才添加」；B 的官方 Node 实现写 `signingStr += '?' + query`；C 的示例直接把 `'/v3/stat/usage?granularity=day&start=…%2B08:00'` 整串塞进 `path`；A 同构。**没有任何一处官方文档把 query 单独成行**——独立 query 行的写法只出现在个别镜像/二次转载里，对 `api.qnaigc.com` 无效（会得 `invalid ak/sk sign`）。

因此实现默认 `queryMode:"path"`（官方）。为排查保留了两个开关（**默认关闭，别在生产里用**）：
- `queryMode:"line"` → `GET /v3/stat/usage\n<query>\nHost: …\n\n`
- `style:"split-lines"` → `GET\n/v3/stat/usage\n<query>\napi.qnaigc.com\n\n`（aitokenapi 早期「每元素一行」排版口径）

两者在测试里都有固定期望值（`yEHZ6bEz_6KnNZdpgM3GEEt4oRY=` / `HyRImtI_oEhtaH80tn6JWmjFinc=`），一旦线上真出现口径分歧可以直接切，不必改代码。

### 2.2 query 签的是「编码后」的串（最容易错的一条）

结论：**签 = 上线的那一串**，即先百分号编码、再原样参与签名；不做 `decodeURIComponent`/`encodeURI` 之类的二次改写。依据：C 的官方示例 `path:'/v3/stat/usage?...start=2025-10-01T00:00:00%2B08:00&end=2025-10-31T23:59:59%2B08:00'` 与同页 curl 示例都写成 `%2B`；`timezone=Asia/Shanghai` 在 C 的示例里为 `Asia%2FShanghai`。B/A 也只说「Query：URL 中的查询部分（不包含 `?`）」——URL 上的查询部分天然已是编码态。

对 `start=2026-11-18T00:00:00+08:00`：
- `+` **必须**编码成 `%2B` 再签再发。裸 `+` 在服务端 query 解析里等于空格，`Time.Parse` 直接失败；而签名串又会与真实上线串不一致，报 `invalid ak/sk sign`。
- `:` 和 `-` 是 RFC3986 允许出现在 query 的字符，官方示例保持裸态（`2025-10-01T00:00:00%2B08:00`），照抄即可；编码成 `%3A` 同样自洽（只要签名与上线完全一致）。
- `timezone=Asia/Shanghai` 的 `/` 建议编码成 `%2F`（C 的示例如此）。
- 调用侧推荐：`new URL("https://api.qnaigc.com/v1")` → `u.search = ""` → 逐参 `u.searchParams.append(k, String(v))` 交给 WHATWG 编码 → **把最终 URL 原样交给 `signingString({url})`**；`fetch` 也用同一个 URL。`splitUrl()` 只做切片（去 fragment、剥 userinfo、空 path 补 `/`），绝不改写百分号。

### 2.3 Host 行：域名，或带端口的 authority

A/B 正文说 Host 是「请求域名」；官方参考实现里 `host` 是调用方直接传进去的字段（示例传 `'api.qnaigc.com'`）。结论：
- 默认端口的 URL（443/80）→ 就是纯域名：`api.qnaigc.com`、`api.qiniu.com` 都能签（测试分别覆盖）。
- URL 显式带端口时，`Host` 取 URL authority 原样（`api.qiniu.com:8443`），与 HTTP/1.1 请求实际发出的 `Host:` 头一致——这也是 Go 服务端校验时的取值来源；可用 `host` 参数显式覆盖。
- 一致性红线：**签名里的 Host 必须等于真实请求头 Host**，否则 `invalid ak/sk sign`。CONTRACT §1.4 那条「`Host: api.qiniu.com`」只描述域名场景，不是要求剥端口。
- 两个域名单独签互不通用：签名串含 Host，换域名必须重签（`api.qiniu.com` 的 billing-api 与 `api.qnaigc.com` 的 v3 用量接口都要签）。

### 2.4 body 排除集与排序（两处口径合并说明）

- 官方文档只明确排除 `application/octet-stream`；CONTRACT §3 额外要求 `application/x-www-form-urlencoded`、`multipart/form-data` 不附 body（与七牛各语言 SDK 的 `CreateSigningString` 一致）。实现取并集，且 **Content-Type 为空时也不附 body**（对齐 B 的官方 JS 片段 `if (body && contentType && contentType !== "application/octet-stream")`）。⚠️ 待复核：Go SDK 源码本次没抓到（jsdelivr/raw 均 404），这三条并集里只有 octet-stream 有文档逐字支撑；`qnaigc` 的接口全是 JSON，`-urlencoded`/`multipart` 两条实际用不到。
- `X-Qiniu-*` 排序：文档正文写「`<key>` 按 ASCII 升序」，而 B 的 JS 片段是**先按原始 key 排序再格式化**——大小写混乱时两者不同（片段视为 bug）。实现按**规范化后的 key** 排序（测试第 11 条锁定 `X-Qiniu-Audit` 先于 `X-Qiniu-Zlib`），与服务端 Go `http.Header` 的规范化行为一致。调用侧只要自己把头名写成规范形式（如 `X-Qiniu-Date`），两种排序就等价。
- `Content-Type` 只出现一行：显式参数优先，其次取 headers 里的 `content-type`（不会重复输出）。
- 空 `Authorization` 之外不参与签名的头：`Content-MD5`/`Content-Type` 以外的普通头一律不参与（A/B 同）。

## 3. 导出与用法

```js
export function signingString({ method, url, contentType = "", body = "", headers = {}, accessKey,
                                host, queryMode = "path", style = "request-line" }) // → 待签字符串
export function qiniuAuthHeader({ method, url, contentType, body, headers, accessKey, secretKey,
                                  host, queryMode, style })                          // → "Qiniu <AK>:<sig>"
export function splitAksk(value) // → { ok:boolean, accessKey?:string, secretKey?:string, error?:string }
export function urlSafeBase64Encode(buf)
export function canonicalXQiniuKey(key)
export function nowXQiniuDate(now = new Date())
export function splitUrl(url) // → { host, path, query }（不改写百分号）
```

- 三个契约导出签名未改；`signingString` 的新参数全部有默认值（向后兼容）。
- `qiniuAuthHeader` 在 AK/SK 为空时抛 `TypeError`；`splitAksk` 只回 code（`not_string/empty/too_many_colons/too_many_commas/too_many_fields/api_key_not_aksk/no_separator/missing_part/space_in_part/bad_chars/too_short`），**不回显输入**，满足 CONTRACT §0「不打印 secret」。
- `accessKey` 在 `signingString` 里是保留位：Qiniu 签名串本身不含 AK（代码里 `void o.accessKey`）。

## 4. 测试

`plugin/tests/sign.test.mjs`：22 条 `node:test`，`node:assert/strict`，全离线。期望值由独立一次性脚本按本文规则用 `node:crypto` 现算后写死（测试里不再调用被测函数推导）。覆盖：文档黄金样例、GET 带编码 query、GET 无 query、POST json+body、form-urlencoded 不附 body、multipart 不附 body、空 body、octet-stream 不附 body、PUT json、`X-Qiniu-*` 全小写排序、大小写混乱排序、query+`X-Qiniu-Date`、contentType 回退、尾斜杠、hash、端口 + 双域名、两个备用开关、输入归一化（Map/数组值/Uint8Array/对象 body）、`splitAksk` 合法 4 例与非法 12 例、空 AK/SK 抛错、输出不含 secretKey。

```
bun test plugin/tests/sign.test.mjs   →  22 pass / 0 fail（exit 0，bun 1.4.5）
```
