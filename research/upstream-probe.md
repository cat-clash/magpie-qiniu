# 上游实测 · api.qnaigc.com / api.qiniu.com（A1 · probe）

> 本文**事实段全部为「实测」**，由 `_tools/probe-upstream.mjs` 自动生成于 2026-11-24T21:25:37.922Z（bun 1.4.5，global fetch，请求 38 个，间隔 300ms）。
> 凭据：只用无效 key `sk-invalid-probe`（`--dry` 可复算计划）。原始响应见 `_tools/models-dump.json`。
> 段末 `<!-- ANALYSIS --> ` 之后是人工结论与契约修订建议，重跑时原样保留。

## 1. `GET /v1/models` 无鉴权（实测）

- HTTP **200**；顶层字段：`object, data`；条目数 **91**。
- 条目字段全集（7 个）：`context_length, created, id, max_tokens, object, owned_by, service_status`
- **非核心字段**（核心 = id/object/created/owned_by/context_length/max_tokens/service_status）：
  - 无。上游**不返回**任何模态 / 价格 / 分组 / 能力字段。
- 模态/价格/分组字段命中清单：`（无）`
- `max_tokens`：**0 值 6 条**，null/缺失 0 条 → CONTRACT §1 的「绝不能把 limit.output 写成 0」**实测成立**。
- `context_length` 缺失/null：0 条。
- `service_status` 全部取值：`available`×87、`unavailable`×4
- `owned_by` 全部取值（1 个）：`system`×91
- `object` 取值：`model`×91
- `created` 区间：1754380642..1794814904（2025-08-05T07:57:22.000Z .. 2026-11-16T07:41:44.000Z）
- 带无效 key 的同请求：HTTP 401（见 §2 矩阵）。

<details><summary>`id | context_length | max_tokens | service_status` 全表（91 行）</summary>

| id | context_length | max_tokens | service_status |
| --- | ---: | ---: | --- |
| meituan/longcat-flash-lite | 256000 | 320000 | available |
| qwen3-vl-30b-a3b-thinking | 128000 | 32000 | available |
| doubao-1.5-pro-32k | 128000 | 12000 | available |
| doubao-1.5-vision-pro | 128000 | 16000 | available |
| glm-4.5 | 131072 | 98304 | available |
| kimi-k2 | 128000 | 128000 | available |
| qwen-turbo | 1000000 | 0 | available |
| qwen-vl-max-2025-01-25 | 128000 | 0 | available |
| qwen2.5-vl-72b-instruct | 128000 | 8192 | available |
| qwen3-235b-a22b | 128000 | 32000 | available |
| qwen3-30b-a3b | 40000 | 0 | available |
| qwen3-235b-a22b-instruct-2507 | 262144 | 64000 | available |
| qwen3-235b-a22b-thinking-2507 | 262144 | 4096 | available |
| deepseek-v3 | 128000 | 16000 | unavailable |
| qwen3-coder-480b-a35b-instruct | 262000 | 4096 | available |
| doubao-seed-1.6 | 256000 | 32000 | available |
| doubao-seed-1.6-flash | 256000 | 32000 | available |
| doubao-seed-1.6-thinking | 256000 | 32000 | available |
| deepseek-v3.1 | 128000 | 32000 | unavailable |
| qwen3-next-80b-a3b-thinking | 131072 | 32768 | available |
| qwen3-next-80b-a3b-instruct | 131072 | 32768 | available |
| deepseek/deepseek-v3.2-exp-thinking | 128000 | 32000 | unavailable |
| z-ai/glm-4.6 | 200000 | 200000 | available |
| moonshotai/kimi-k2-thinking | 256000 | 100000 | available |
| deepseek/deepseek-v3.2-251201 | 128000 | 32000 | unavailable |
| z-ai/glm-4.7 | 200000 | 200000 | available |
| qwen3-30b-a3b-thinking-2507 | 126000 | 32000 | available |
| z-ai/glm-4.5-air-free | 0 | 0 | available |
| tencent/hy3-preview | 262144 | 262144 | available |
| qwen/qwen3.6-27b | 262100 | 262100 | available |
| deepseek/deepseek-v4-flash-202605 | 1000000 | 384000 | available |
| nvidia/nemotron-3-ultra-550b-a55b0-free | 1000000 | 128000 | available |
| moonshotai/kimi-k3-free | 1048576 | 1048576 | available |
| z-ai/glm-5.1 | 200000 | 128000 | available |
| moonshotai/kimi-k2.6 | 262000 | 262000 | available |
| deepseek/deepseek-v4-flash | 1000000 | 384000 | available |
| deepseek/deepseek-v4-pro | 1000000 | 384000 | available |
| qwen/qwen3.7-max | 1000000 | 64000 | available |
| minimax/minimax-m3 | 1000000 | 128000 | available |
| deepseek/deepseek-v4-pro-202606 | 1000000 | 384000 | available |
| moonshotai/kimi-k2.7-code | 262144 | 262144 | available |
| z-ai/glm-5.2 | 1000000 | 128000 | available |
| qwen/qwen3.7-plus | 1000000 | 64000 | available |
| bytedance/doubao-seed-2-1-pro | 256000 | 256000 | available |
| bytedance/doubao-seed-2-1-turbo | 256000 | 256000 | available |
| stepfun/step-3.7-flash | 256000 | 256000 | available |
| moonshotai/kimi-k3 | 1048576 | 1048576 | available |
| deepseek/deepseek-v4-flash-20260731 | 1000000 | 0 | available |
| qwen/qwen3.8-max | 1000000 | 128000 | available |
| deepseek/deepseek-v4-pro-0813 | 1000000 | 384000 | available |
| z-ai/glm-5.3 | 1000000 | 128000 | available |
| deepseek/deepseek-v4-flash-vision-exp | 1000000 | 384000 | available |
| qwen/qwen3.8-flash-next | 1000000 | 128000 | available |
| z-ai/glm-5.3-flash | 1000000 | 128000 | available |
| tencent/hy4-preview | 1000000 | 128000 | available |
| deepseek/deepseek-v4.1-flash | 1000000 | 384000 | available |
| qwen/qwen3.7-flash | 1000000 | 128000 | available |
| xiaomi/mimo-v2.6-pro | 1000000 | 128000 | available |
| xiaomi/mimo-v2.6-flash | 1000000 | 128000 | available |
| bytedance/doubao-seed-2-1-lite | 1024000 | 256000 | available |
| qwen/qwen3.8-omni-flash | 1000000 | 131072 | available |
| deepseek/deepseek-v4.1-flash-1017 | 1000000 | 384000 | available |
| minimax/minimax-m3.1-flash | 1000000 | 512000 | available |
| qiniu/conatus-free | 1000000 | 128000 | available |
| moonshotai/kimi-k3.1-pro | 1048576 | 1048576 | available |
| moonshotai/kimi-k3.1-pro-highspeed | 1048576 | 1048576 | available |
| tencent/hy4 | 1000000 | 64000 | available |
| sensenova/sensenova-6.8-flash | 1048576 | 131072 | available |
| sensenova/sensenova-6.8-flash-lite | 262144 | 65536 | available |
| qwen/qwen4-max | 1000000 | 393000 | available |
| tencent/hy4-flash | 1000000 | 64000 | available |
| z-ai/glm-5 | 200000 | 128000 | available |
| minimax/minimax-m2.5 | 204800 | 128000 | available |
| minimax/minimax-m2.5-highspeed | 204800 | 128000 | available |
| doubao-seed-2.0-code | 256000 | 128000 | available |
| doubao-seed-2.0-pro | 256000 | 128000 | available |
| doubao-seed-2.0-mini | 256000 | 32000 | available |
| doubao-seed-2.0-lite | 256000 | 32000 | available |
| qwen3.5-397b-a17b | 256000 | 64000 | available |
| minimax/minimax-m2.7 | 204800 | 128000 | available |
| MiniMax-M1 | 1000000 | 80000 | available |
| qwen-max-2025-01-25 | 128000 | 4096 | available |
| qwen3-32b | 40000 | 0 | available |
| qwen3-max-preview | 256000 | 64000 | available |
| qwen3-max | 262144 | 65536 | available |
| minimax/minimax-m2 | 200000 | 128000 | available |
| minimax/minimax-m2.1 | 204800 | 128000 | available |
| moonshotai/kimi-k2.5 | 256000 | 256000 | available |
| qwen3-30b-a3b-instruct-2507 | 128000 | 32000 | available |
| qwen/qwen3.5-plus | 1000000 | 64000 | available |
| qwen/qwen3.6-plus | 1000000 | 64000 | available |

</details>

## 2. 错误矩阵（逐字错误体 + 关键响应头）（实测）

| # | probe | method+url | HTTP | server | x-request-id | www-authenticate | retry-after | x-magpie-* | content-type |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| 1 | `models.noauth` | GET `api.qnaigc.com/v1/models` | 200 | APISIX | 64bad189-a95f-475d-a37f-b3700f8ea981 | - | - | - | application/json; charset=utf-8 |
| 2 | `models.badkey` | GET `api.qnaigc.com/v1/models` | 401 | APISIX | 398b6ea9-e3e7-4fde-81d1-6c56a7d0bf11 | - | - | - | application/json; charset=utf-8 |
| 3 | `chat.nonstream.badkey` | POST `api.qnaigc.com/v1/chat/completions` | 401 | APISIX | 28001ef0-4196-4534-b646-96c93000fd0c | - | - | - | application/json; charset=utf-8 |
| 4 | `chat.stream.badkey` | POST `api.qnaigc.com/v1/chat/completions` | 401 | APISIX | ff6a7ef2-2194-4c22-8bb0-99af6f3bc2b8 | - | - | - | application/json; charset=utf-8 |
| 5 | `chat.nonstream.noauth` | POST `api.qnaigc.com/v1/chat/completions` | 401 | APISIX | e2e12ee0-58ce-410a-955d-c9b202fa4fb7 | - | - | - | application/json; charset=utf-8 |
| 6 | `messages.post.badkey` | POST `api.qnaigc.com/v1/messages` | 401 | APISIX | 1d3d847f-b503-4f60-a840-75d7b96db7db | - | - | - | application/json; charset=utf-8 |
| 7 | `messages.stream.badkey` | POST `api.qnaigc.com/v1/messages` | 401 | APISIX | 34785203-24e5-4dc2-b945-0b778f296760 | - | - | - | application/json; charset=utf-8 |
| 8 | `messages.get.badkey` | GET `api.qnaigc.com/v1/messages` | 405 | APISIX | e47687fc-8267-45a6-b39e-194026e8ce9e | - | - | - | application/json; charset=utf-8 |
| 9 | `usage.badkey` | GET `api.qnaigc.com/v3/stat/usage` | 401 | APISIX | 32aa2907-c4ae-4d80-b772-b61ce54d0241 | - | - | - | application/json; charset=utf-8 |
| 10 | `usage.noauth` | GET `api.qnaigc.com/v3/stat/usage` | 200 | APISIX | e729e5ea-ec8a-4b94-9481-8d5599c204f9 | - | - | - | application/json; charset=utf-8 |
| 11 | `usage.badkey.baddates` | GET `api.qnaigc.com/v3/stat/usage?granularity=day&start=bad&end=bad` | 401 | APISIX | 7167d8d8-c791-4d1f-a0ce-afe8cb87a580 | - | - | - | application/json; charset=utf-8 |
| 12 | `usage.noauth.baddates` | GET `api.qnaigc.com/v3/stat/usage?granularity=day&start=bad&end=bad` | 200 | APISIX | 822c6a45-7292-4004-8cfc-c68dc40e1fd3 | - | - | - | application/json; charset=utf-8 |
| 13 | `usage.badkey.badgran` | GET `api.qnaigc.com/v3/stat/usage?granularity=bogus` | 401 | APISIX | 6360d533-efb9-4e19-b03f-0bf2221880d0 | - | - | - | application/json; charset=utf-8 |
| 14 | `usage.noauth.badgran` | GET `api.qnaigc.com/v3/stat/usage?granularity=bogus` | 200 | APISIX | d8a4b887-f8ae-480b-a2d3-59ce846e0a16 | - | - | - | application/json; charset=utf-8 |
| 15 | `cost.badkey` | GET `api.qnaigc.com/v3/stat/usage/apikey/cost?type=day` | 401 | APISIX | d3196e97-9943-4531-b30c-3e30253cdcea | - | - | - | application/json; charset=utf-8 |
| 16 | `exportlog.badkey` | GET `api.qnaigc.com/v2/stat/export_log?size=10&page=1` | 401 | APISIX | c49a552e-2e77-4d38-8849-b7e49df52552 | - | - | - | application/json; charset=utf-8 |
| 17 | `quota.badkey` | GET `api.qnaigc.com/v1/apikey/quota/sk-invalid-probe` | 401 | APISIX | 46902e9b-9d99-49c2-b45c-0a8f2c40ae11 | - | - | - | application/json; charset=utf-8 |
| 18 | `quota.noauth` | GET `api.qnaigc.com/v1/apikey/quota/sk-invalid-probe` | 401 | APISIX | 48cdd937-7594-481a-8367-0c888a60eb9b | - | - | - | application/json; charset=utf-8 |
| 19 | `quota.badsign` | GET `api.qnaigc.com/v1/apikey/quota/sk-invalid-probe` | 401 | APISIX | 7633aa53-8fcd-4b0a-b2ab-9a78f9ff6d05 | - | - | - | application/json; charset=utf-8 |
| 20 | `apikeys.post.badkey` | POST `api.qnaigc.com/v1/apikeys` | 401 | APISIX | f8e5c93e-41a3-475b-8085-fb5377fed720 | - | - | - | application/json; charset=utf-8 |
| 21 | `balance.noauth` | GET `api.qiniu.com/billing-api/v1/account/balance-overview` | 401 | openresty | WvsAAACb-nk_GOsY, WvsAAACb-nk_GOsY | - | - | - | - |
| 22 | `balance.badsign` | GET `api.qiniu.com/billing-api/v1/account/balance-overview` | 401 | openresty | 5VIAAAAEiYw_GOsY, 5VIAAAAEiYw_GOsY | - | - | - | - |
| 23 | `respack.badsign` | GET `api.qiniu.com/billing-api/v1/respack/list` | 401 | openresty | GQEAAAA8IZ8_GOsY, GQEAAAA8IZ8_GOsY | - | - | - | - |
| 24 | `model.detail.noauth` | GET `api.qnaigc.com/v1/models/deepseek-chat` | 404 | APISIX | 0bbc4999-4e75-41eb-bd93-2f5b2ef7c87b | - | - | - | application/json; charset=utf-8 |
| 25 | `model.detail.badkey` | GET `api.qnaigc.com/v1/models/deepseek-chat` | 401 | APISIX | a57fb629-e973-4a5a-a56f-0b2750e1b1d4 | - | - | - | application/json; charset=utf-8 |
| 26 | `ua.curl` | GET `api.qnaigc.com/v1/models` | 200 | APISIX | f3b1f84e-f245-45a1-ae77-f4afe97654c3 | - | - | - | application/json; charset=utf-8 |
| 27 | `ua.browser` | GET `api.qnaigc.com/v1/models` | 200 | APISIX | 96edb04f-1d2b-4d0f-a71b-e6b1196198ae | - | - | - | application/json; charset=utf-8 |
| 28 | `ua.empty` | GET `api.qnaigc.com/v1/models` | 200 | APISIX | be538d49-6e9f-4f3e-9e42-10973ab71c23 | - | - | - | application/json; charset=utf-8 |
| 29 | `ua.none.chat` | POST `api.qnaigc.com/v1/chat/completions` | 401 | APISIX | 40be7786-f109-4a16-815e-3384de986f53 | - | - | - | application/json; charset=utf-8 |
| 30 | `embeddings.badkey` | POST `api.qnaigc.com/v1/embeddings` | 401 | APISIX | ec49ad20-e5f2-4383-82ee-cbf8648d693b | - | - | - | application/json; charset=utf-8 |
| 31 | `audio.speech.badkey` | POST `api.qnaigc.com/v1/audio/speech` | 401 | APISIX | 45949c57-9160-4bc8-a630-45d68b77092b | - | - | - | application/json; charset=utf-8 |
| 32 | `images.generations.badkey` | POST `api.qnaigc.com/v1/images/generations` | 401 | APISIX | 40385abe-6d0f-40bb-a960-fe8aa944cb57 | - | - | - | application/json; charset=utf-8 |
| 33 | `root.badkey` | GET `api.qnaigc.com/` | 404 | APISIX | - | - | - | - | text/plain; charset=utf-8 |
| 34 | `control.badkey` | GET `api.qnaigc.com/v1/definitely-not-a-route-xyz` | 401 | APISIX | b57a8d38-7b4d-4fb9-838e-08a8eb9fba64 | - | - | - | application/json; charset=utf-8 |
| 35 | `control.noauth` | GET `api.qnaigc.com/v1/definitely-not-a-route-xyz` | 404 | APISIX | 875315ba-d156-4b46-9be2-d731c7fd643f | - | - | - | application/json; charset=utf-8 |
| 36 | `embeddings.noauth` | POST `api.qnaigc.com/v1/embeddings` | 404 | APISIX | 02474a90-d84b-4615-a8cf-08476a3f7067 | - | - | - | application/json; charset=utf-8 |
| 37 | `audio.speech.noauth` | POST `api.qnaigc.com/v1/audio/speech` | 404 | APISIX | 63b83b0a-76f0-4b11-9eb0-41b5d7cba3c7 | - | - | - | application/json; charset=utf-8 |
| 38 | `images.generations.noauth` | POST `api.qnaigc.com/v1/images/generations` | 401 | APISIX | c9c5b582-1637-4f7e-9293-f4fccd622cdd | - | - | - | application/json; charset=utf-8 |

### 2.1 逐字响应体

**`models.noauth`** → HTTP 200 · 14768B

_（截断到 6000B）_
```json
{"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":1770370439,"owned_by":"system","context_length":256000,"max_tokens":320000,"service_status":"available"},{"id":"qwen3-vl-30b-a3b-thinking","object":"model","created":1770629483,"owned_by":"system","context_length":128000,"max_tokens":32000,"service_status":"available"},{"id":"doubao-1.5-pro-32k","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":12000,"service_status":"available"},{"id":"doubao-1.5-vision-pro","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":16000,"service_status":"available"},{"id":"glm-4.5","object"…[+5300]
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:30 GMT
eo-cache-status: MISS
eo-log-uuid: 11601888167090944742
server: APISIX
transfer-encoding: chunked
x-reqid: 64bad189-a95f-475d-a37f-b3700f8ea981
```

**`models.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:30 GMT
eo-cache-status: MISS
eo-log-uuid: 7138267368475519241
server: APISIX
x-reqid: 398b6ea9-e3e7-4fde-81d1-6c56a7d0bf11
```

**`chat.nonstream.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:30 GMT
eo-cache-status: MISS
eo-log-uuid: 6446692050025414074
server: APISIX
x-reqid: 28001ef0-4196-4534-b646-96c93000fd0c
```

**`chat.stream.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:31 GMT
eo-cache-status: MISS
eo-log-uuid: 6387179490675466308
server: APISIX
x-reqid: ff6a7ef2-2194-4c22-8bb0-99af6f3bc2b8
```

**`chat.nonstream.noauth`** → HTTP 401 Authorization Required · 189B

```json
{"error":{"message":"No valid authentication credentials were provided (request_id: chatcmpl-7ccdf03fe00e42c6a06920d7f9abdf20)","type":"authentication_error","code":"auth_api_key_missing"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 189
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:31 GMT
eo-cache-status: MISS
eo-log-uuid: 9312207362481396023
http_x_reqid: chatcmpl-7ccdf03fe00e42c6a06920d7f9abdf20
server: APISIX
x-reqid: e2e12ee0-58ce-410a-955d-c9b202fa4fb7
```

**`messages.post.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-origin: *
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:31 GMT
eo-cache-status: MISS
eo-log-uuid: 15332389581335165887
etag: W/"63-kpkg8neXe/h6JfMUFSqbck2zcHA"
server: APISIX
x-powered-by: Express
x-reqid: 1d3d847f-b503-4f60-a840-75d7b96db7db
```

**`messages.stream.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-origin: *
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:32 GMT
eo-cache-status: MISS
eo-log-uuid: 541135493100532761
etag: W/"63-kpkg8neXe/h6JfMUFSqbck2zcHA"
server: APISIX
x-powered-by: Express
x-reqid: 34785203-24e5-4dc2-b945-0b778f296760
```

**`messages.get.badkey`** → HTTP 405 Method Not Allowed · 30B

```json
{"error":"Method Not Allowed"}
```

<summary>全部响应头</summary>

```
access-control-allow-origin: *
connection: keep-alive
content-length: 30
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:32 GMT
eo-cache-status: MISS
eo-log-uuid: 2172864022805934984
etag: W/"1e-IBweH4Vj7lDovJDf9KQOpDMeplg"
server: APISIX
x-powered-by: Express
x-reqid: e47687fc-8267-45a6-b39e-194026e8ce9e
```

**`usage.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:32 GMT
eo-cache-status: MISS
eo-log-uuid: 964858087936609881
server: APISIX
x-reqid: 32aa2907-c4ae-4d80-b772-b61ce54d0241
```

**`usage.noauth`** → HTTP 200 · 56B

```json
{"status":false,"error":"UNAUTHENTICATED","errcode":401}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 56
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:33 GMT
eo-cache-status: MISS
eo-log-uuid: 4815407679367963055
server: APISIX
x-reqid: e729e5ea-ec8a-4b94-9481-8d5599c204f9
```

**`usage.badkey.baddates`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:33 GMT
eo-cache-status: MISS
eo-log-uuid: 17508828293991429498
server: APISIX
x-reqid: 7167d8d8-c791-4d1f-a0ce-afe8cb87a580
```

**`usage.noauth.baddates`** → HTTP 200 · 56B

```json
{"status":false,"error":"UNAUTHENTICATED","errcode":401}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 56
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:33 GMT
eo-cache-status: MISS
eo-log-uuid: 7973534084993935077
server: APISIX
x-reqid: 822c6a45-7292-4004-8cfc-c68dc40e1fd3
```

**`usage.badkey.badgran`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:34 GMT
eo-cache-status: MISS
eo-log-uuid: 17207070157367195221
server: APISIX
x-reqid: 6360d533-efb9-4e19-b03f-0bf2221880d0
```

**`usage.noauth.badgran`** → HTTP 200 · 56B

```json
{"status":false,"error":"UNAUTHENTICATED","errcode":401}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 56
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:34 GMT
eo-cache-status: MISS
eo-log-uuid: 15700507158879779635
server: APISIX
x-reqid: d8a4b887-f8ae-480b-a2d3-59ce846e0a16
```

**`cost.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:35 GMT
eo-cache-status: MISS
eo-log-uuid: 8022268810365192003
server: APISIX
x-reqid: d3196e97-9943-4531-b30c-3e30253cdcea
```

**`exportlog.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:35 GMT
eo-cache-status: MISS
eo-log-uuid: 1742991041839244958
server: APISIX
x-reqid: c49a552e-2e77-4d38-8849-b7e49df52552
```

**`quota.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:35 GMT
eo-cache-status: MISS
eo-log-uuid: 6519519613005001398
server: APISIX
x-reqid: 46902e9b-9d99-49c2-b45c-0a8f2c40ae11
```

**`quota.noauth`** → HTTP 401 Authorization Required · 84B

```json
{"status":false,"error":{"message":"invalid ak/sk sign","type":"authorization err"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 84
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:36 GMT
eo-cache-status: MISS
eo-log-uuid: 474408984852161006
server: APISIX
x-reqid: 48cdd937-7594-481a-8367-0c888a60eb9b
```

**`quota.badsign`** → HTTP 401 Authorization Required · 84B

```json
{"status":false,"error":{"message":"invalid ak/sk sign","type":"authorization err"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 84
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:36 GMT
eo-cache-status: MISS
eo-log-uuid: 9434040332766771445
server: APISIX
x-reqid: 7633aa53-8fcd-4b0a-b2ab-9a78f9ff6d05
```

**`apikeys.post.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:36 GMT
eo-cache-status: MISS
eo-log-uuid: 13787195694179025689
server: APISIX
x-reqid: f8e5c93e-41a3-475b-8085-fb5377fed720
```

**`balance.noauth`** → HTTP 401 Unauthorized · 0B

```text
*(空 body)*
```

<summary>全部响应头</summary>

```
connection: keep-alive
content-length: 0
date: Tue, 24 Nov 2026 21:25:37 GMT
server: openresty
x-log: APIS/401
x-reqid: WvsAAACb-nk_GOsY, WvsAAACb-nk_GOsY
x-trace: 22e5726803a556fc:22e5726803a556fc:0000000000000000:1
```

**`balance.badsign`** → HTTP 401 Unauthorized · 0B

```text
*(空 body)*
```

<summary>全部响应头</summary>

```
connection: keep-alive
content-length: 0
date: Tue, 24 Nov 2026 21:25:37 GMT
server: openresty
x-log: APIS/401
x-reqid: 5VIAAAAEiYw_GOsY, 5VIAAAAEiYw_GOsY
x-trace: 3041474458592f36:3041474458592f36:0000000000000000:1
```

**`respack.badsign`** → HTTP 401 Unauthorized · 0B

```text
*(空 body)*
```

<summary>全部响应头</summary>

```
connection: keep-alive
content-length: 0
date: Tue, 24 Nov 2026 21:25:37 GMT
server: openresty
x-log: APIS/401
x-reqid: GQEAAAA8IZ8_GOsY, GQEAAAA8IZ8_GOsY
x-trace: 6d52696908824cbe:6d52696908824cbe:0000000000000000:1
```

**`model.detail.noauth`** → HTTP 404 Not Found · 60B

```json
{"message":"not found or method not allowed","status":false}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 60
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:38 GMT
eo-cache-status: MISS
eo-log-uuid: 18228817954323272342
server: APISIX
x-reqid: 0bbc4999-4e75-41eb-bd93-2f5b2ef7c87b
```

**`model.detail.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:38 GMT
eo-cache-status: MISS
eo-log-uuid: 16417042647683178186
server: APISIX
x-reqid: a57fb629-e973-4a5a-a56f-0b2750e1b1d4
```

**`ua.curl`** → HTTP 200 · 14768B

_（截断到 6000B）_
```json
{"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":1770370439,"owned_by":"system","context_length":256000,"max_tokens":320000,"service_status":"available"},{"id":"qwen3-vl-30b-a3b-thinking","object":"model","created":1770629483,"owned_by":"system","context_length":128000,"max_tokens":32000,"service_status":"available"},{"id":"doubao-1.5-pro-32k","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":12000,"service_status":"available"},{"id":"doubao-1.5-vision-pro","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":16000,"service_status":"available"},{"id":"glm-4.5","object"…[+5300]
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:38 GMT
eo-cache-status: MISS
eo-log-uuid: 5525849830450080029
server: APISIX
transfer-encoding: chunked
x-reqid: f3b1f84e-f245-45a1-ae77-f4afe97654c3
```

**`ua.browser`** → HTTP 200 · 14768B

_（截断到 6000B）_
```json
{"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":1770370439,"owned_by":"system","context_length":256000,"max_tokens":320000,"service_status":"available"},{"id":"qwen3-vl-30b-a3b-thinking","object":"model","created":1770629483,"owned_by":"system","context_length":128000,"max_tokens":32000,"service_status":"available"},{"id":"doubao-1.5-pro-32k","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":12000,"service_status":"available"},{"id":"doubao-1.5-vision-pro","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":16000,"service_status":"available"},{"id":"glm-4.5","object"…[+5300]
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:39 GMT
eo-cache-status: MISS
eo-log-uuid: 2282441941415650774
server: APISIX
transfer-encoding: chunked
x-reqid: 96edb04f-1d2b-4d0f-a71b-e6b1196198ae
```

**`ua.empty`** → HTTP 200 · 14768B

_（截断到 6000B）_
```json
{"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":1770370439,"owned_by":"system","context_length":256000,"max_tokens":320000,"service_status":"available"},{"id":"qwen3-vl-30b-a3b-thinking","object":"model","created":1770629483,"owned_by":"system","context_length":128000,"max_tokens":32000,"service_status":"available"},{"id":"doubao-1.5-pro-32k","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":12000,"service_status":"available"},{"id":"doubao-1.5-vision-pro","object":"model","created":1754380642,"owned_by":"system","context_length":128000,"max_tokens":16000,"service_status":"available"},{"id":"glm-4.5","object"…[+5300]
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:39 GMT
eo-cache-status: MISS
eo-log-uuid: 17313139499929335855
server: APISIX
transfer-encoding: chunked
x-reqid: be538d49-6e9f-4f3e-9e42-10973ab71c23
```

**`ua.none.chat`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:39 GMT
eo-cache-status: MISS
eo-log-uuid: 13845205846976071809
server: APISIX
x-reqid: 40be7786-f109-4a16-815e-3384de986f53
```

**`embeddings.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:40 GMT
eo-cache-status: MISS
eo-log-uuid: 14391092568680115756
server: APISIX
x-reqid: ec49ad20-e5f2-4383-82ee-cbf8648d693b
```

**`audio.speech.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:40 GMT
eo-cache-status: MISS
eo-log-uuid: 4808127611246581023
server: APISIX
x-reqid: 45949c57-9160-4bc8-a630-45d68b77092b
```

**`images.generations.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:41 GMT
eo-cache-status: MISS
eo-log-uuid: 8912887776277932901
server: APISIX
x-reqid: 40385abe-6d0f-40bb-a960-fe8aa944cb57
```

**`root.badkey`** → HTTP 404 Not Found · 36B

```json
{"error_msg":"404 Route Not Found"}
```

<summary>全部响应头</summary>

```
connection: keep-alive
content-type: text/plain; charset=utf-8
date: Tue, 24 Nov 2026 21:25:41 GMT
eo-cache-status: MISS
eo-log-uuid: 1872825650872713609
server: APISIX
transfer-encoding: chunked
```

**`control.badkey`** → HTTP 401 Authorization Required · 99B

```json
{"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 99
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:41 GMT
eo-cache-status: MISS
eo-log-uuid: 5107199607485897558
server: APISIX
x-reqid: b57a8d38-7b4d-4fb9-838e-08a8eb9fba64
```

**`control.noauth`** → HTTP 404 Not Found · 60B

```json
{"message":"not found or method not allowed","status":false}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 60
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:42 GMT
eo-cache-status: MISS
eo-log-uuid: 18002901896380211953
server: APISIX
x-reqid: 875315ba-d156-4b46-9be2-d731c7fd643f
```

**`embeddings.noauth`** → HTTP 404 Not Found · 60B

```json
{"message":"not found or method not allowed","status":false}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 60
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:42 GMT
eo-cache-status: MISS
eo-log-uuid: 12712033270810219633
server: APISIX
x-reqid: 02474a90-d84b-4615-a8cf-08476a3f7067
```

**`audio.speech.noauth`** → HTTP 404 Not Found · 60B

```json
{"message":"not found or method not allowed","status":false}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 60
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:42 GMT
eo-cache-status: MISS
eo-log-uuid: 10118683838180902969
server: APISIX
x-reqid: 63b83b0a-76f0-4b11-9eb0-41b5d7cba3c7
```

**`images.generations.noauth`** → HTTP 401 Authorization Required · 129B

```json
{"error":{"message":"invalid api key (request_id: chatimagegen-23826dcaacdc4ce2a92c790d57eaae1a)","type":"authentication_error"}}
```

<summary>全部响应头</summary>

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-length: 129
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:43 GMT
eo-cache-status: MISS
eo-log-uuid: 10330112878831809377
http_x_reqid: chatimagegen-23826dcaacdc4ce2a92c790d57eaae1a
server: APISIX
x-reqid: c9c5b582-1637-4f7e-9293-f4fccd622cdd
```

### 2.2 响应头层面的统一事实

- 带 `www-authenticate` 的响应：**0 个**（全站不用该头）
- 带 `retry-after` 的响应：**0 个**（未观察到 429/退避头）
- 带 `x-magpie-*` 的响应：**0 个**（没有任何 magpie 私有头）
- 带请求 ID（`x-request-id`/`x-reqid`）的响应：37/38
  样本：`x-request-id: 64bad189-a95f-475d-a37f-b3700f8ea981`
- **空 body** 的响应：balance.noauth, balance.badsign, respack.badsign
- `server` 头取值集合：`APISIX`, `openresty`（api.qnaigc.com = APISIX 网关；api.qiniu.com = openresty）
- content-type 取值集合：`application/json`, `text/plain`
- 出现过的 HTTP 状态码：200, 401, 404, 405

## 3. 流式（`stream:true` + 无效 key）的返回形态（实测）

- `POST /v1/chat/completions stream:true` → **HTTP 401**，`content-type: application/json; charset=utf-8`，body 前缀 `{"error":{"message":"Invalid API key","type":"authentication_error","c`。
  结论：**普通 JSON 错误体（不是 SSE）** → 分档只看状态码，**不需要**解析 SSE。
- `POST /v1/messages stream:true` → **HTTP 401**，`content-type: application/json; charset=utf-8`，body 前缀 `{"error":{"message":"Invalid API key","type":"authentication_error","c`。
  结论：**普通 JSON 错误体（不是 SSE）**。

## 4. `/v3/stat/usage` 参数校验 vs 鉴权的先后（实测）

| 组合 | probe | HTTP | 错误体首行 |
| --- | --- | ---: | --- |
| 无鉴权 + 无参数 | `usage.noauth` | 200 | {"status":false,"error":"UNAUTHENTICATED","errcode":401} |
| 无效 key + 无参数 | `usage.badkey` | 401 | {"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}} |
| 无鉴权 + 坏 start/end | `usage.noauth.baddates` | 200 | {"status":false,"error":"UNAUTHENTICATED","errcode":401} |
| 无效 key + 坏 start/end | `usage.badkey.baddates` | 401 | {"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}} |
| 无鉴权 + granularity=bogus | `usage.noauth.badgran` | 200 | {"status":false,"error":"UNAUTHENTICATED","errcode":401} |
| 无效 key + granularity=bogus | `usage.badkey.badgran` | 401 | {"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}} |

- 无鉴权下「坏参数」与「无参数」返回同状态（200 vs 200）→ **鉴权先于参数校验**：成立。
- 因此**无 key 无法用 400 反推参数名**；参数语义只能靠文档（A3）。

## 5. `/v1/messages`（Anthropic）通路（实测）

- POST 无效 key → HTTP 401；chat/completions → HTTP 401。
- 同构判定：状态码相同，body schema 同构（同为 OpenAI 风格 error 对象）。
- GET /v1/messages → HTTP 405（405=路由存在但方法不符；404=路由不存在）→ 路由存在性：**存在**。

## 6. `GET /v1/models/<id>` 详情端点（实测）

- 无鉴权 → HTTP 404；无效 key → HTTP 401。
- 首行响应：`{"message":"not found or method not allowed","status":false}`

## 7. 服务端指纹 / UA 差异（实测）

| probe | UA 设置 | HTTP | server | body 首行 |
| --- | --- | ---: | --- | --- |
| `models.noauth` | (Bun 默认) | 200 | APISIX | {"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":177 |
| `ua.curl` | curl/8.6.0 | 200 | APISIX | {"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":177 |
| `ua.browser` | Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 | 200 | APISIX | {"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":177 |
| `ua.empty` | "" | 200 | APISIX | {"object":"list","data":[{"id":"meituan/longcat-flash-lite","object":"model","created":177 |
| `root.badkey` | (Bun 默认) | 404 | APISIX | {"error_msg":"404 Route Not Found"} |

```json
// Bun 回环自检：不同设置下**实际发出**的 user-agent
[object Object]
```

- 四种 UA 表现（去重后 2 种）→ **存在 UA 差异**，见 §2.1 逐字。

## 8. 其它端点存在性（先做控制实验，再判定）（实测）

**方法学前提**：`/v1/**` 上只要带了 `Authorization: Bearer`（哪怕无效），网关先鉴权 → 401，**根本不看路径存不存在**。所以「401」不能证明路由存在。反过来，**完全不带** `Authorization` 时请求会进应用层，应用层没有的路由返回 404（见控制组）。判定表用「无鉴权」那一列。

| 端点 | 带无效 key | 无鉴权 | 判定（据无鉴权列） |
| --- | ---: | ---: | --- |
| POST /v1/embeddings | 401 | 404 | **不存在**（应用层 404/405） |
| POST /v1/audio/speech | 401 | 404 | **不存在**（应用层 404/405） |
| POST /v1/images/generations | 401 | 401 | 路由**存在**（请求到达应用层） |
| GET /v1/definitely-not-a-route-xyz（控制组） | 401 | 404 | **不存在**（应用层 404/405） |
| GET /v3/stat/usage/apikey/cost | 401 | （未测） | **无法判定**（只测到网关 401，需无鉴权复测） |
| GET /v2/stat/export_log | 401 | （未测） | **无法判定**（只测到网关 401，需无鉴权复测） |
| GET /v1/apikey/quota/:key | 401 | 401 | 路由**存在**（请求到达应用层） |
| POST /v1/apikeys | 401 | （未测） | **无法判定**（只测到网关 401，需无鉴权复测） |
| GET billing-api/account/balance-overview | 401 | 401 | 未定（401） |
| GET billing-api/respack/list | 401 | （未测） | **无法判定**（只测到网关 401，需无鉴权复测） |

- 控制组证明：不存在的 `/v1/definitely-not-a-route-xyz` 无鉴权 → HTTP 404，带无效 key → HTTP 401 → **鉴权先于路由匹配**。

## 9. `GET /v1/models` 无鉴权响应头（实测）

```
access-control-allow-credentials: true
access-control-allow-headers: 
access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-origin: 
access-control-expose-headers: Http_x_reqid
connection: keep-alive
content-type: application/json; charset=utf-8
date: Tue, 24 Nov 2026 21:25:30 GMT
eo-cache-status: MISS
eo-log-uuid: 11601888167090944742
server: APISIX
transfer-encoding: chunked
x-reqid: 64bad189-a95f-475d-a37f-b3700f8ea981
```

- dump 文件：`_tools/models-dump.json`（14768 字符，逐字未加工）。

---

<!-- ANALYSIS:BEGIN -->
## 10. 结论与契约修订建议（人工判读）

标注：**[实测]** = 本次探测直接观测；**[文档]** = 来自 CONTRACT §1 转述的官方文档，本次未能复现；**[推断]** = 由实测事实推出的工程结论。

### 10.1 八条核心结论

1. **`GET /v1/models` 匿名可用** [实测]：不带 `Authorization` → 200 + 91 条；**但只要带了 Bearer（哪怕已过期/无效）→ 401** `auth_api_key_invalid`。同一端点两种行为，说明网关的 key-auth 是「有头才校验」。
   → 工程含义：**过期 key 也能拿到真实模型列表**，只要在 401 之后去掉 `Authorization` 重试一次。
2. **模型条目只有 7 个字段** [实测]：`id / object / created / owned_by / context_length / max_tokens / service_status`。**没有任何**模态（modalities）、价格（pricing/cost）、分组（group/tags）、能力（capabilities/tools/reasoning）字段。
   → `reasoning` / `tool_call` / `modalities` / `cost` **只能靠 id 白名单与文档**（§2 的 `free?` 同理由 A4 的 `FREE_IDS` 承担），不能指望上游。
3. **`service_status` 取值集合 = `{available, unavailable}`** [实测 87/4]；4 条 `unavailable` 是 `deepseek-v3`、`deepseek-v3.1`、`deepseek/deepseek-v3.2-exp-thinking`、`deepseek/deepseek-v3.2-251201`。`owned_by` **恒为 `system`** [实测 91/91]，无厂商/分组语义。
4. **`max_tokens=0` 实测 6 条，且 `context_length` 也会是 0** [实测]：6 条零 output 里，`z-ai/glm-4.5-air-free` 的 `context_length` 也是 0。→ 契约只防了 `limit.output=0`，**`limit.context=0` 同样必须回退**。
5. **同一个 401 有两种 `code`** [实测]：
   - `auth_api_key_invalid` = 发了坏 key（99B，`{"error":{"message":"Invalid API key",...}}`）
   - `auth_api_key_missing` = 压根没发 Authorization（189B，message 里内嵌 `request_id: chatcmpl-…`）
   → 只有前者意味着「账号失效」。把两者都映射成 `sign_in_required` 会让「插件自己忘带 key」伪装成「用户需要重新登录」。
6. **`/v3/stat/usage` 的无鉴权不是 HTTP 401，而是 `200` + `{"status":false,"error":"UNAUTHENTICATED","errcode":401}`** [实测]。计费域 `api.qiniu.com` 的 401 则是 **0 字节 body、无 content-type**（`server: openresty`）[实测]。
   → 用量链路**必须**做 `status===false || errcode` 判定，并对空 body 给兜底文案。
7. **`/v1/messages` 路由存在** [实测]：`POST` → 401（与 chat 完全同构的网关错误）；`GET` 同路径 → **405** `{"error":"Method Not Allowed"}`（不是 404）。但 body 层是否为 Anthropic schema **无法用无效 key 验证** [未实测]。
8. **`/v1/models/<id>` 不存在** [实测 404 `{"message":"not found or method not allowed","status":false}`]；**`/v1/embeddings`、`/v1/audio/speech` 不存在** [实测：无鉴权 404，与「瞎编路径」控制组同体]；**`/v1/images/generations` 存在** [实测：无鉴权 401 `invalid api key (request_id: chatimagegen-…)`，前缀 `chatimagegen-` 证明到了图像服务]。

### 10.2 对 §1「上游事实」的修订建议

| # | 现文 | 建议改为 | 依据 |
| --- | --- | --- | --- |
| 1 | `Anthropic` 行标注「（待 A1 复核可用性）」 | 「路由存在（POST 401 / GET 405 实测）；body 级 Anthropic 兼容性需真 key，未实测」 | [实测] |
| 2 | 「`service_status` 已知值 `available`；其余取值待 A1 确认」 | 「取值集合 `{available, unavailable}`，实测 87/4；**只有 `available` 视为可用**，`unavailable` 与未知值一律隐藏」 | [实测] |
| 3 | 「`max_tokens` 可能为 `0`（表示未给）→ 必须回退默认」 | 追加：「`context_length` 同样可能为 `0`（实测 `z-ai/glm-4.5-air-free`）→ `limit.context` 也必须回退 `DEFAULT_LIMITS`，否则零上下文模型会被下游直接判死」 | [实测] |
| 4 | 表格无「模型清单可用性」行 | 新增一行：「`GET /v1/models` **匿名可读**（无 `Authorization` → 200）；带任何 Bearer 则 401」 | [实测] |
| 5 | 表格无「详情/其它能力」行 | 新增：「`/v1/models/:id` 不支持；`/v1/embeddings`、`/v1/audio/speech` 不支持；`/v1/images/generations` 存在（插件不转发）」 | [实测] |
| 6 | 无鉴权错误体只写了 `Invalid API key` | 补充两条并列文案：`auth_api_key_missing`（没带 key）与 `{"status":false,"error":"UNAUTHENTICATED","errcode":401}`（v3 用量，HTTP 200）+ 计费域 401 空 body | [实测] |
| 7 | 429/402/403 文案来自文档 | 保留，但标注「文档，未实测」；并补一句「全站响应**无** `www-authenticate`、**无** `retry-after`、**无** `x-magpie-*`；`x-request-id` 恒有，可作诊断串」 | [实测] |
| 8 | 无 `owned_by` 说明 | 新增：「`owned_by` 恒为 `system`，不含厂商/分组信息，不可用于分类」 | [实测] |

### 10.3 对 §5「loader.fetch 路由与错误分档」的修订建议

1. **第 2 条（`GET **/models`）必须改成三段回退**：
   `带 Bearer 转发 → 401/403 时**去掉 Authorization 重发一次**（匿名 200，实测） → 仍失败才 `modelsResponse(staticModelTable())``。
   现文「失败回退静态表」会让**过期 key 的用户只看到静态表**，白白丢掉 91 条实时模型。
2. **第 6 条（401 → `x-magpie-sign-in: expired`）要按 `error.code` 细分**：
   - `auth_api_key_invalid` → 原样透传 + `expired`（账号确实需要处理）
   - `auth_api_key_missing` → 这是插件侧没带凭据，返回 **500 `missing_credential`**（不要 `expired`，否则前端弹「请重新登录」掩盖真 bug）
   - 无 `code` 字段的 401 → 按 `Invalid API key` 文案匹配，兜底走 `expired`
3. **第 3/4 条现状正确**，但补一句：`/v1/messages` 的 401 与 `/v1/chat/completions` **逐字相同**，因此两条路由可以共用同一个错误分档函数（无需 Anthropic 专用分支）。
4. **新增一条规则（建议插在第 2 条后）**：`/v1/**` 上「带 key 的 404」**不可信**——网关先鉴权后匹配路由，带 key 时未知路径是 401 而非 404。所以**不要**把上游 404 当作「路由不存在」来判断功能开关；只把 **应用层 404 体**（`{"message":"not found or method not allowed","status":false}`）当不存在。
5. **第 5 条（其它 → 501）建议保留**，但 README 需写明只支持 `models` / `chat/completions` / `messages`；`embeddings` 与 `audio/speech` 在上游**也是 404**（不是「插件没实现」），`images/generations` 上游有但插件不转发。
6. **第 7 条（402 重写）**建议追加：`clone()` 后判空 body —— 计费域 401 实测 0 字节，上游若在 402 也返回空体，`errorText()` 必须能回退到 `HTTP 402` 而不是空串。

### 10.4 给其它子智能体的硬提示

- **A2（sign）**：签名错时上游的逐字反馈是 `{"status":false,"error":{"message":"invalid ak/sk sign","type":"authorization err"}}`（HTTP 401，`/v1/apikey/quota/:key`）。测试里直接断言这个字符串。
- **A3（usage-api）**：`fetchUsageSeries`/`fetchKeyQuota` 必须按 **body** 判错：`status===false` 或存在 `errcode` 即失败（HTTP 可能仍是 200）；计费域要能处理 0 字节 body。
- **A4（catalog）**：上游**不提供**任何模态/价格/分组字段，`CATALOG` 必须自带这些信息；测试夹具用实测的真实 id：`deepseek-v3`（unavailable）、`z-ai/glm-4.5-air-free`（cl=0 且 mt=0）、`qwen-turbo`（mt=0）。
- **A8（测试）**：新增两条可断言行为——① 上游 401 时 `provider.models` 返回**同一引用**；② models 401 后**匿名重试**能拿到 91 条（用 fetch 桩注入两次响应）。

### 10.5 本次未能实测的边界（不要当作已验证）

- 402 余额不足、403 `Request not allowed` / `apikey monthly quota exceeded` / `is not available in your assigned model groups`、503 `the price of the model is not set`、429 的 RPM/TPM/TPD 文案：**都需要有效 key**，仍为 [文档]。
- `/v1/messages` 是否真按 Anthropic schema 解析（`max_tokens` 必填、`content` 数组、`anthropic-version` 头）：无效 key 在网关层就被拦，**测不到 body 层**。
- 余额单位（元 × 1e8）、订阅积分无接口：仍为 [文档]。
- `root.badkey` 两次跑分别返回 `403 {"message":"Your IP address is not allowed"}` 与 `404 {"error_msg":"404 Route Not Found"}` → 站点根**指纹不稳定**（疑似 IP 白名单漂移），**不要**拿它做健康检查。
<!-- ANALYSIS:END -->
