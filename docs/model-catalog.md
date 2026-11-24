# 七牛 AI 推理 · 模型静态目录

`plugin/src/catalog.mjs` 里那 91 条模型条目，就是本文档逐条列出的这 91 行；本文档是它的可读视图与**判定依据**。
改 `catalog.mjs` 之前先读 §2（上游字段怎么映射）和 §3（能力位怎么判、三档置信度怎么打）。

一句话总结：**limits 与隐藏位 100% 来自上游 `/v1/models`；vision / reasoning / toolCall / free 100% 来自七牛模型广场的文档字段，id 命名规律只当交叉校验，不进任何判定结果。**

## 1. 数据来源与抓取方式

两路来源，互相补齐、互相对账：

| 用途 | 地址 | 拿到了什么 | 落盘 |
| --- | --- | --- | --- |
| 权威字段 | `GET https://api.qnaigc.com/v1/models`（匿名可读，实测 HTTP 200） | `id` / `context_length` / `max_tokens` / `service_status` / `owned_by`（91 条全部 `system`） | `research/models-live.json`（原始响应） |
| 能力与价格 | <https://www.qiniu.com/ai/models> 的 `__NEXT_DATA__` → `props.pageProps.models`（SSR，124 张卡片） | `name` / `features` / `architecture.input_modalities` / `architecture.reasoning.supported` / `architecture.function_calling.supported` / `hot_tags` / `pricing_rules_v2` / `model_alias` / `retirement_at` / `support_api_protocols` / `service_status` | 生成期临时文件（页面快照 534KB，不进仓库） |

抓取时间：**2026-11-25（Asia/Singapore）**。

对账结果：

- 广场 124 张卡片，91 条上游 id **全部命中（91/91，0 未匹配）**；
- 双源重叠的 `context_length` / `max_tokens` / `service_status` **逐字相同，0 处差异** → 两源不矛盾，可以放心互相补齐；
- `developer.qiniu.com/aitokenapi` 及其计费页 `/12898/ai-token-api-pricing` 只有导航与计费口径（还有「新用户送 300 万 tokens」这类活动文案），**没有逐模型表**，因此不作为判定来源，只在「哪些字段存在」上做过确认。

上游响应里 `owned_by` 恒为 `system`、`created` 与文档 `release_at` 不一致（不代表版本新旧），两者都不使用。

## 2. 上游字段与我们的映射

| 上游 / 文档字段 | 样例 | CATALOG 字段 | 规则 | 置信度 |
| --- | --- | --- | --- | --- |
| `data[].id` | `deepseek/deepseek-v4-flash`、`qwen-turbo` | `id` | 原样照抄。上游 id 混用两种风格：带命名空间的 `厂商/模型` 与不带前缀的历史短 id，**不要统一加前缀或去前缀** | 上游字段 |
| `data[].context_length` | `1000000` | `context` | `>0` 原样；`=0` → `DEFAULT_LIMITS.context`(131072) + `note` 记 `ctx-0`（实测 1 条） | 上游字段 |
| `data[].max_tokens` | `384000` | `output` | `>0` 原样；`=0` → `DEFAULT_LIMITS.output`(8192) + `note` 记 `upstream-0`（实测 6 条） | 上游字段 |
| `data[].service_status` | `available` / `unavailable` | `HIDDEN_IDS` + `note` | 只有 `available` 算可用；其余一律进 `HIDDEN_IDS` 并记 `status=<值>`（实测 87 / 4） | 上游字段 |
| 文档 `name` | `DeepSeek-V4-Flash` | `name` | 去厂商前缀、连字符转空格、`GLM`/`VL`/`Qwen3` 保留原大小写、规格词统一（`30b`→`30B`、`a3b`→`A3B`、`32k`→`32K`）、`20260731` 还原成 `2026-07-31`；文档名丢了 id 尾部版本号时补回来 | 文档 |
| 文档 `architecture.input_modalities` + `features` | `["text","image"]` | `vision` | 见 §3 | 文档 |
| 文档 `architecture.reasoning.supported` + `features` | `true` | `reasoning` | 见 §3 | 文档 |
| 文档 `architecture.function_calling.supported` + `features` | `true` | `toolCall` | 见 §3 | 文档 |
| 文档 `hot_tags` / `pricing_rules_v2` / id | `["限时免费"]` | `free` + `rate` | 见 §3；`free:true` 时 `rate:0`，否则 `rate:1` | 文档 |
| 文档 `model_alias` | `glm-5.2` → `z-ai/glm-5.2` | `DOC_ALIASES` | 别名剥掉自映射后导出，供 `models.mjs` 的 `resolveModelId` 用 | 文档 |
| 文档 `retirement_at` | `2026-06-02` | `note` | **不参与隐藏**，只记 `retiring=<日期>`（未来）或 `etd-past=<日期>`（已过），见 §2.3 | 文档 |

### 2.1 上游 `max_tokens=0` 为什么回退成 8192

上游 `max_tokens=0` 的语义是「**未公布上限**」，不是「不许输出」。直接抄成 `limit.output = 0` 会让宿主把模型判成 0 token 预算：列表里不可选，甚至每次请求都因剩余预算为 0 立刻中止（CONTRACT §1 明令禁止写 0）。取 8192 的理由：

1. 它是上游真实出现过的档位——91 条里 `max_tokens` 的非零最小档是 4096（3 条），8192 档 1 条，中位数 128000；8192 落在「不会比任何已知档位高太多」的安全区；
2. 方向性：写大了上游会因 `max_tokens` 超限回 400，写小只截断输出 —— 所以取小档，不用中位数；
3. 它只用于宿主算预算/显示。**真正发请求时建议对这 6 条不带 `max_tokens`**，让服务端用它自己的默认值（`qwen-vl-max` 这类真实上限只有 2k 的模型，硬塞 8192 会 400）。

受影响的 6 条（`note` 以 `upstream-0` 标记，测试把它写死成 `UPSTREAM_ZERO_MAX_TOKENS = 6`）：
`qwen-turbo`、`qwen-vl-max-2025-01-25`、`qwen3-30b-a3b`、`z-ai/glm-4.5-air-free`、`deepseek/deepseek-v4-flash-20260731`、`qwen3-32b`。它们的文档卡片 `max_completion_tokens` 同样是 0，没有第二来源可校准。

反例提醒：`qwen2.5-vl-72b-instruct` 的 `output` 也正好是 8192，但那是**上游真值**，不是回退值，所以它**不带** `upstream-0`。测试专门守这一点（反方向断言会把它误标成第 7 条）。

### 2.2 上游 `context_length=0`

实测只有 1 条：`z-ai/glm-4.5-air-free`。回退 `DEFAULT_LIMITS.context` = 128 × 1024 = 131072，与七牛控制台对该模型的「128K 上下文」口径一致，`note` 记 `ctx-0`。

### 2.3 `service_status` 的处理：只认上游，不认退役日期

- 判定式：`service_status === "available"` 才算可用，其余（含未来出现的新取值）一律进 `HIDDEN_IDS`。实测取值只有 `available`(87) 与 `unavailable`(4)，但代码按「未知即隐藏」写，新值不会误放出来。
- 隐藏的 4 条：`deepseek-v3`、`deepseek-v3.1`、`deepseek/deepseek-v3.2-exp-thinking`、`deepseek/deepseek-v3.2-251201`。
- 文档 `retirement_at` **不参与隐藏**：49 条退役日期已经过去（`etd-past=…`）而上游依旧 `available` —— 七牛并没有按文档下线，据此隐藏会把一批在售模型藏掉。只有 `tencent/hy4-preview` 是未来退役（2026-12-07 → `retiring=2026-12-07`）。

### 2.4 `max_tokens > context_length`

全表唯一：`meituan/longcat-flash-lite`（`context_length` 256000 / `max_tokens` 320000）。**照抄上游不修正**，`note` 记 `out>ctx`，由 `models.mjs` 发请求前夹到 `context` 内。测试守着「全表只有这 1 条」。

## 3. 能力判定规则与三档置信度

三档置信度的定义（本目录所有判定都落在这三档之一）：

| 档位 | 含义 | 本目录用法 |
| --- | --- | --- |
| **上游字段** | 直接来自 `GET /v1/models` | `id` / `context` / `output` / 隐藏位，91/91 条；上游只给这四类信息，没有任何模态与价格字段 |
| **文档** | 来自七牛模型广场卡片的 `features` / `architecture` / `hot_tags` / `pricing_rules_v2` | 全部能力位与免费位，91/91 条命中卡片 |
| **推断** | 仅靠 id 命名规律的启发式 | **不进入任何判定结果**，只做 §4 的交叉校验（用来证明命名规律不可靠） |

判定式（`∨` = 并集，任一来源说「有」就算有）：

| 能力 | 判定式 | 两源都 yes | 仅模态/仅 rs/仅 fc | 仅标签 | 两源都 no | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| `vision` | `input_modalities ∋ {image, video}` ∨ `features ∋ {图像理解, 视频理解, 全模态理解}` | 40 | 5 | 0 | 46 | **45 条** |
| `reasoning` | `architecture.reasoning.supported === true` ∨ `features ∋ 深度思考` | 57 | 13 | 11 | 10 | **81 条** |
| `toolCall` | `architecture.function_calling.supported === true` ∨ `features ∋ 工具调用` | 80 | 1 | 9 | 1 | **90 条**（唯一 false：`doubao-1.5-vision-pro`） |
| `free` | `hot_tags ∋ {免费, 限时免费}` ∨ 全部单价 = 0 ∨ id 含 `free` | 标签 4 / 单价 0 共 5（4 条重叠） / id 含 free 4 | — | — | — | **5 条** |
| `rate` | `free ? 0 : 1` | — | — | — | — | 5 条 0 / 86 条 1 |

`free` 的 5 条：`meituan/longcat-flash-lite`（文档「限时免费」+ 单价 0，但 id 里没有 `free` → `note` 记 `free-no-id-mark`）、`z-ai/glm-4.5-air-free`、`nvidia/nemotron-3-ultra-550b-a55b0-free`、`moonshotai/kimi-k3-free`、`qiniu/conatus-free`。

**冲突处理原则：取并集（能力存在即给）。** 理由：文档 `architecture` 字段在老模型上明显滞后——`glm-4.5` 标着 `function_calling.supported=false`，但同一张卡片又挂「工具调用」标签，实际也能调；能力**漏标**会让宿主把多模态模型当纯文本、把能调工具的模型截断工具调用，比误标更伤。误标的兜底放在 `forwardChat` 的错误分档（上游回 400/422 时提示能力位可疑），不在目录层做保守裁剪。

置信度分布（按条目计，一条多字段冲突只算一次）：

| 置信度 | 条目数 | 说明 |
| --- | --- | --- |
| 文档 · 双源一致 | **61** | vision/reasoning/toolCall 三个判定式里，模态与标签、`supported` 与标签完全一致 |
| 文档 · 双源冲突 → 取并集 | **30** | 上述三项中至少一项冲突（reasoning 冲突 24 条、toolCall 冲突 10 条、vision 冲突 5 条，存在重叠） |
| 纯推断 | **0** | 命名规律没有参与任何一条的判定 |
| 上游字段（limits/status） | **91 / 91** | 无一条 limits 来自文档或猜测 |

## 4. 命名规律为什么只能当校验

用 id 的命名规律去推能力，在真实数据上错得离谱，所以它只用于 CI 交叉校验（计数写在这里，测试会红）：

| 规律 | 与文档结论不一致的条目数 | 典型反例 |
| --- | --- | --- |
| `vl` / `vision` / `omni` / `-v\d+-pro` → 视觉 | **41 / 91** | 假阳性 3 条：`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-pro-202606`、`deepseek/deepseek-v4-pro-0813` 只吃文本（`note` 记 `name-vision-fp`）；假阴性 38 条：`qwen/qwen3.7-plus`、`bytedance/doubao-seed-*`、`xiaomi/mimo-*` 等 38 个多模态模型的 id 里没有任何视觉字样 |
| `thinking` / `reason` / `-r1` → 推理 | **74 / 91** | 大量推理模型的 id 不带思考字样；反过来 `highspeed` 系列（如 `deepseek-v4-flash-highspeed`）名字像 `high` 但**不**开思考 |
| id 含 `free` → 免费 | **1 / 91** | `meituan/longcat-flash-lite` 是真免费，id 里却没有 `free` |

## 5. 完整表格

列说明：`context` / `output` 是本目录给宿主的值（上游 0 已回退）；`上游 ctx / max` 是上游原值，`0` 表示「未公布」；
`依据` 依次是 vision、reasoning、工具调用、免费四个判定位的证据来源；`置信度` 是该条目的双源一致情况；`note` 是条目上的标记串（字典见 `catalog.mjs` 顶部注释）。

| id | name | context | output | vision | reasoning | free | 工具调用 | 隐藏 | 上游 ctx / max | 依据（vision；reasoning；工具；免费） | 置信度 | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `meituan/longcat-flash-lite` | LongCat Flash Lite | 256,000 | 320,000 | — | ✅ | ✅ | ✅ |  | 256000 / 320000 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(hot 免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-06-02;out>ctx;free-no-id-mark` |
| `qwen3-vl-30b-a3b-thinking` | Qwen3 VL 30B A3B Thinking | 128,000 | 32,000 | ✅ | ✅ | — | ✅ |  | 128000 / 32000 | 文档(mod+feat)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-07-07` |
| `doubao-1.5-pro-32k` | Doubao 1.5 Pro 32K | 128,000 | 12,000 | — | — | — | ✅ |  | 128000 / 12000 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-14` |
| `doubao-1.5-vision-pro` | Doubao 1.5 Vision Pro | 128,000 | 16,000 | ✅ | — | — | ✗ |  | 128000 / 16000 | 文档(mod+feat)；文档(rs=false 且无标签)；文档(fc=false 且无标签)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-03-31;no-tools` |
| `glm-4.5` | GLM 4.5 | 131,072 | 98,304 | — | ✅ | — | ✅ |  | 131072 / 98304 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-07-02` |
| `kimi-k2` | Kimi K2 | 128,000 | 128,000 | — | — | — | ✅ |  | 128000 / 128000 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-05-27` |
| `qwen-turbo` | Qwen Turbo | 1,000,000 | 8,192 | — | ✅ | — | ✅ |  | 1000000 / 0 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `upstream-0;etd-past=2026-07-08` |
| `qwen-vl-max-2025-01-25` | Qwen VL Max 2025-01-25 | 128,000 | 8,192 | ✅ | — | — | ✅ |  | 128000 / 0 | 文档(mod+feat)；文档(rs=false 且无标签)；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `upstream-0;etd-past=2026-07-08;in:audio` |
| `qwen2.5-vl-72b-instruct` | Qwen 2.5 VL 72B Instruct | 128,000 | 8,192 | ✅ | — | — | ✅ |  | 128000 / 8192 | 文档(mod+feat)；文档(rs=false 且无标签)；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-06-02;in:audio` |
| `qwen3-235b-a22b` | Qwen 3 235B A22B | 128,000 | 32,000 | — | ✅ | — | ✅ |  | 128000 / 32000 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-08-04` |
| `qwen3-30b-a3b` | Qwen3 30B A3B | 40,000 | 8,192 | — | ✅ | — | ✅ |  | 40000 / 0 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `upstream-0;etd-past=2026-07-07` |
| `qwen3-235b-a22b-instruct-2507` | Qwen3 235B A22B Instruct 2507 | 262,144 | 64,000 | — | — | — | ✅ |  | 262144 / 64000 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-04` |
| `qwen3-235b-a22b-thinking-2507` | Qwen3 235B A22B Thinking 2507 | 262,144 | 4,096 | — | ✅ | — | ✅ |  | 262144 / 4096 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-04` |
| `deepseek-v3` | DeepSeek V3 | 128,000 | 16,000 | — | — | — | ✅ | 🚫 | 128000 / 16000 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `status=unavailable;etd-past=2026-10-09` |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B A35B Instruct | 262,000 | 4,096 | — | — | — | ✅ |  | 262000 / 4096 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-07-07` |
| `doubao-seed-1.6` | Doubao Seed 1.6 | 256,000 | 32,000 | ✅ | ✅ | — | ✅ |  | 256000 / 32000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-14` |
| `doubao-seed-1.6-flash` | Doubao Seed 1.6 Flash | 256,000 | 32,000 | ✅ | ✅ | — | ✅ |  | 256000 / 32000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-03-31` |
| `doubao-seed-1.6-thinking` | Doubao Seed 1.6 Thinking | 256,000 | 32,000 | ✅ | ✅ | — | ✅ |  | 256000 / 32000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-03-31` |
| `deepseek-v3.1` | DeepSeek V3.1 | 128,000 | 32,000 | — | ✅ | — | ✅ | 🚫 | 128000 / 32000 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `status=unavailable;etd-past=2026-08-04` |
| `qwen3-next-80b-a3b-thinking` | Qwen3 Next 80B A3B Thinking | 131,072 | 32,768 | — | ✅ | — | ✅ |  | 131072 / 32768 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-10-09` |
| `qwen3-next-80b-a3b-instruct` | Qwen3 Next 80B A3B Instruct | 131,072 | 32,768 | — | — | — | ✅ |  | 131072 / 32768 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-07-07` |
| `deepseek/deepseek-v3.2-exp-thinking` | DeepSeek V3.2 Exp Thinking | 128,000 | 32,000 | — | ✅ | — | ✅ | 🚫 | 128000 / 32000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc=true)·无标签；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `status=unavailable;etd-past=2026-07-16` |
| `z-ai/glm-4.6` | GLM 4.6 | 200,000 | 200,000 | — | ✅ | — | ✅ |  | 200000 / 200000 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-06-30` |
| `moonshotai/kimi-k2-thinking` | Kimi K2 Thinking | 256,000 | 100,000 | — | ✅ | — | ✅ |  | 256000 / 100000 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-07-01` |
| `deepseek/deepseek-v3.2-251201` | DeepSeek V3.2 251201 | 128,000 | 32,000 | — | ✅ | — | ✅ | 🚫 | 128000 / 32000 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `status=unavailable;etd-past=2026-09-29` |
| `z-ai/glm-4.7` | GLM 4.7 | 200,000 | 200,000 | — | ✅ | — | ✅ |  | 200000 / 200000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-06-30` |
| `qwen3-30b-a3b-thinking-2507` | Qwen3 30B A3B Thinking 2507 | 126,000 | 32,000 | — | ✅ | — | ✅ |  | 126000 / 32000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-07-07` |
| `z-ai/glm-4.5-air-free` | GLM 4.5 Air Free | 131,072 | 8,192 | — | ✅ | ✅ | ✅ |  | 0 / 0 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(hot 免费标签) | 文档(双源冲突→取并集) | `upstream-0;ctx-0;etd-past=2026-06-25` |
| `tencent/hy3-preview` | Hy3 Preview | 262,144 | 262,144 | — | ✅ | — | ✅ |  | 262144 / 262144 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-31` |
| `qwen/qwen3.6-27b` | Qwen3.6 27B | 262,100 | 262,100 | ✅ | ✅ | — | ✅ |  | 262100 / 262100 | 文档(mod)·feat 无标签；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-10-14` |
| `deepseek/deepseek-v4-flash-202605` | DeepSeek V4 Flash 202605 | 1,000,000 | 384,000 | — | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-18` |
| `nvidia/nemotron-3-ultra-550b-a55b0-free` | Nemotron 3 Ultra 550B A55B Free | 1,000,000 | 128,000 | — | ✅ | ✅ | ✅ |  | 1000000 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(全部单价=0) | 文档(双源一致) | |
| `moonshotai/kimi-k3-free` | Kimi K3 Free | 1,048,576 | 1,048,576 | ✅ | ✅ | ✅ | ✅ |  | 1048576 / 1048576 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(hot 免费标签) | 文档(双源一致) | `etd-past=2026-10-27` |
| `z-ai/glm-5.1` | GLM 5.1 | 200,000 | 128,000 | — | ✅ | — | ✅ |  | 200000 / 128000 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | 262,000 | 262,000 | ✅ | ✅ | — | ✅ |  | 262000 / 262000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1,000,000 | 384,000 | — | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-10-25` |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 384,000 | — | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-10-25;name-vision-fp` |
| `qwen/qwen3.7-max` | Qwen3.7 Max | 1,000,000 | 64,000 | — | ✅ | — | ✅ |  | 1000000 / 64000 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `minimax/minimax-m3` | MiniMax M3 | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `deepseek/deepseek-v4-pro-202606` | DeepSeek V4 Pro 202606 | 1,000,000 | 384,000 | — | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-08-18;name-vision-fp` |
| `moonshotai/kimi-k2.7-code` | Kimi K2.7 Code | 262,144 | 262,144 | ✅ | ✅ | — | ✅ |  | 262144 / 262144 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `z-ai/glm-5.2` | GLM 5.2 | 1,000,000 | 128,000 | — | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `qwen/qwen3.7-plus` | Qwen3.7 Plus | 1,000,000 | 64,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 64000 | 文档(mod+feat)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `in:audio` |
| `bytedance/doubao-seed-2-1-pro` | Doubao Seed 2.1 Pro | 256,000 | 256,000 | ✅ | ✅ | — | ✅ |  | 256000 / 256000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `bytedance/doubao-seed-2-1-turbo` | Doubao Seed 2.1 Turbo | 256,000 | 256,000 | ✅ | ✅ | — | ✅ |  | 256000 / 256000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `stepfun/step-3.7-flash` | Step 3.7 Flash | 256,000 | 256,000 | ✅ | ✅ | — | ✅ |  | 256000 / 256000 | 文档(mod+feat)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-10-23` |
| `moonshotai/kimi-k3` | Kimi K3 | 1,048,576 | 1,048,576 | ✅ | ✅ | — | ✅ |  | 1048576 / 1048576 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `deepseek/deepseek-v4-flash-20260731` | DeepSeek V4 Flash 2026-07-31 | 1,000,000 | 8,192 | — | ✅ | — | ✅ |  | 1000000 / 0 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `upstream-0` |
| `qwen/qwen3.8-max` | Qwen3.8 Max | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod)·feat 无标签；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `deepseek/deepseek-v4-pro-0813` | DeepSeek V4 Pro 0813 | 1,000,000 | 384,000 | — | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `name-vision-fp` |
| `z-ai/glm-5.3` | GLM 5.3 | 1,000,000 | 128,000 | — | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `deepseek/deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision Exp | 1,000,000 | 384,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod)·feat 无标签；文档(深度思考标签)·rs=false；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-10-25` |
| `qwen/qwen3.8-flash-next` | Qwen3.8 Flash | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod)·feat 无标签；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `z-ai/glm-5.3-flash` | GLM 5.3 Flash | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `in:file` |
| `tencent/hy4-preview` | Hy4 Preview | 1,000,000 | 128,000 | — | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `retiring=2026-12-07` |
| `deepseek/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1,000,000 | 384,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `qwen/qwen3.7-flash` | Qwen3.7 Flash | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `xiaomi/mimo-v2.6-pro` | MiMo V2.6 Pro | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `in:audio` |
| `xiaomi/mimo-v2.6-flash` | MiMo V2.6 Flash | 1,000,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `in:audio` |
| `bytedance/doubao-seed-2-1-lite` | Doubao Seed 2.1 Lite | 1,024,000 | 256,000 | ✅ | ✅ | — | ✅ |  | 1024000 / 256000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `in:audio` |
| `qwen/qwen3.8-omni-flash` | Qwen3.8 Omni Flash | 1,000,000 | 131,072 | ✅ | ✅ | — | ✅ |  | 1000000 / 131072 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `in:audio` |
| `deepseek/deepseek-v4.1-flash-1017` | DeepSeek V4.1 Flash 1017 | 1,000,000 | 384,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 384000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `minimax/minimax-m3.1-flash` | MiniMax M3.1 Flash | 1,000,000 | 512,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 512000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `qiniu/conatus-free` | Conatus Free | 1,000,000 | 128,000 | ✅ | ✅ | ✅ | ✅ |  | 1000000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(hot 免费标签) | 文档(双源一致) | |
| `moonshotai/kimi-k3.1-pro` | Kimi K3.1 Pro | 1,048,576 | 1,048,576 | ✅ | ✅ | — | ✅ |  | 1048576 / 1048576 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `moonshotai/kimi-k3.1-pro-highspeed` | Kimi K3.1 Pro HighSpeed | 1,048,576 | 1,048,576 | ✅ | ✅ | — | ✅ |  | 1048576 / 1048576 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `tencent/hy4` | Hy4 | 1,000,000 | 64,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 64000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `sensenova/sensenova-6.8-flash` | SenseNova 6.8 Flash | 1,048,576 | 131,072 | ✅ | ✅ | — | ✅ |  | 1048576 / 131072 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `sensenova/sensenova-6.8-flash-lite` | SenseNova 6.8 Flash Lite | 262,144 | 65,536 | ✅ | ✅ | — | ✅ |  | 262144 / 65536 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `qwen/qwen4-max` | Qwen4 Max | 1,000,000 | 393,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 393000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `tencent/hy4-flash` | Hy4 Flash | 1,000,000 | 64,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 64000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `z-ai/glm-5` | GLM 5 | 200,000 | 128,000 | — | ✅ | — | ✅ |  | 200000 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `minimax/minimax-m2.5` | MiniMax M2.5 | 204,800 | 128,000 | — | ✅ | — | ✅ |  | 204800 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `minimax/minimax-m2.5-highspeed` | MiniMax M2.5 HighSpeed | 204,800 | 128,000 | — | ✅ | — | ✅ |  | 204800 / 128000 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-10-23` |
| `doubao-seed-2.0-code` | Doubao Seed 2.0 Code | 256,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 256000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-11-24` |
| `doubao-seed-2.0-pro` | Doubao Seed 2.0 Pro | 256,000 | 128,000 | ✅ | ✅ | — | ✅ |  | 256000 / 128000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-11-24` |
| `doubao-seed-2.0-mini` | Doubao Seed 2.0 Mini | 256,000 | 32,000 | ✅ | ✅ | — | ✅ |  | 256000 / 32000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `doubao-seed-2.0-lite` | Doubao Seed 2.0 Lite | 256,000 | 32,000 | ✅ | ✅ | — | ✅ |  | 256000 / 32000 | 文档(mod+feat)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | |
| `qwen3.5-397b-a17b` | Qwen3.5 397B A17B | 256,000 | 64,000 | ✅ | ✅ | — | ✅ |  | 256000 / 64000 | 文档(mod+feat)；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `minimax/minimax-m2.7` | MiniMax M2.7 | 204,800 | 128,000 | — | ✅ | — | ✅ |  | 204800 / 128000 | 文档(mod=text 且无标签)；文档(深度思考标签)·rs=false；文档(工具调用标签)·fc=false；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `MiniMax-M1` | MiniMax M1 | 1,000,000 | 80,000 | — | ✅ | — | ✅ |  | 1000000 / 80000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-10-23` |
| `qwen-max-2025-01-25` | Qwen2.5 Max 2025-01-25 | 128,000 | 4,096 | — | ✅ | — | ✅ |  | 128000 / 4096 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-05-30` |
| `qwen3-32b` | Qwen3 32B | 40,000 | 8,192 | — | ✅ | — | ✅ |  | 40000 / 0 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `upstream-0;etd-past=2026-07-07` |
| `qwen3-max-preview` | Qwen3 Max Preview | 256,000 | 64,000 | — | ✅ | — | ✅ |  | 256000 / 64000 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-07-07` |
| `qwen3-max` | Qwen3 Max | 262,144 | 65,536 | — | ✅ | — | ✅ |  | 262144 / 65536 | 文档(mod=text 且无标签)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-07-07` |
| `minimax/minimax-m2` | MiniMax M2 | 200,000 | 128,000 | — | ✅ | — | ✅ |  | 200000 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-07-01` |
| `minimax/minimax-m2.1` | MiniMax M2.1 | 204,800 | 128,000 | — | ✅ | — | ✅ |  | 204800 / 128000 | 文档(mod=text 且无标签)；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-07-01` |
| `moonshotai/kimi-k2.5` | Kimi K2.5 | 256,000 | 256,000 | ✅ | ✅ | — | ✅ |  | 256000 / 256000 | 文档(mod+feat)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | `etd-past=2026-08-31` |
| `qwen3-30b-a3b-instruct-2507` | Qwen3 30B A3B Instruct 2507 | 128,000 | 32,000 | — | — | — | ✅ |  | 128000 / 32000 | 文档(mod=text 且无标签)；文档(rs=false 且无标签)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源一致) | `etd-past=2026-07-07` |
| `qwen/qwen3.5-plus` | Qwen3.5 Plus | 1,000,000 | 64,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 64000 | 文档(mod+feat)；文档(rs=true)·无标签；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
| `qwen/qwen3.6-plus` | Qwen3.6 Plus | 1,000,000 | 64,000 | ✅ | ✅ | — | ✅ |  | 1000000 / 64000 | 文档(mod)·feat 无标签；文档(rs+深度思考)；文档(fc+工具调用)；文档(单价>0 且无免费标签) | 文档(双源冲突→取并集) | |
## 6. 集合与辅助导出

`plugin/src/catalog.mjs` 除 `CATALOG` 外还导出（都是常量，零 import）：

| 导出 | 内容 | 大小 | 谁在用 |
| --- | --- | --- | --- |
| `K` | `1024` | 1 | `DEFAULT_LIMITS` 的可读写法 |
| `DEFAULT_LIMITS` | `{ context: 128 * K = 131072, output: 8192 }` | — | `models.mjs` 在 `context`/`output` 无效时回退（上游 0 也走这里） |
| `CATALOG` | 91 条源条目，字段固定为 `{id,name,context,output,vision,reasoning,free,rate,toolCall,note}` | 91 | `models.mjs` 的 `staticModelTable` / `parseLiveModels` / `resolveModelId` |
| `FREE_IDS` | 5 条 | 5 | 只在拿不到目录条目时兜底判免费 |
| `VISION_IDS` | 45 条 | 45 | 同上 |
| `REASONING_IDS` | 81 条 | 81 | 同上 |
| `HIDDEN_IDS` | 上游 `service_status === "unavailable"` 的 4 条 | 4 | `models.mjs` 把 `status` 落成 `"deprecated"` |
| `NO_TOOL_IDS` | 文档明确不支持工具调用的 1 条 | 1 | `models.mjs` 的 `toolCall` 兜底 |
| `DOC_ALIASES` | 文档 `model_alias` → 上游 id，45 条（已去掉自映射） | 45 | `models.mjs` 的 `resolveModelId` |
| `UPSTREAM_FACTS` | 抓取快照：总数 91 / `max_tokens=0` 6 / `context_length=0` 1 / `unavailable` 4 / 卡片命中 91 + 抓取日期与地址 | — | 测试交叉校验，改数字必须同时改这里和测试里的常量 |
| `catalogEntry(id)` | 精确查表（忽略两侧空白，大小写敏感），未命中返回 `undefined` | — | `models.mjs` 的 `modelEntry` / `resolveModelId` |

`DOC_ALIASES` 举例：`deepseek-v4-flash` → `deepseek/deepseek-v4-flash`、`glm-5.2` → `z-ai/glm-5.2`、`aliyun/qwen-turbo` → `qwen-turbo`、`kimi-k2.6` → `moonshotai/kimi-k2.6`。

## 7. 接 `models.mjs` 时必须注意的坑

1. **不要 `Object.freeze` 目录条目**。`modelEntry` 里有 `if (free) entry.free = true;` 会原地写条目；ESM 严格模式下被冻结的对象会直接抛 `TypeError`。真实数据里这条赋值目前是幂等的（`free:true` 的条目本来就有 `free:true`），但代码路径存在，冻结就会炸。
2. **`upstream-0` 的 6 条别硬塞 `max_tokens`**。`limit.output = 8192` 是我们猜的预算值，仅用于宿主算剩余额度与显示；这 6 条上游没公布上限，其中 `qwen-vl-max-2025-01-25` 的真实输出上限只有 2k 量级，请求里带上 8192 会 400。建议：`note` 含 `upstream-0` 时请求体里省略 `max_tokens`。
3. **`meituan/longcat-flash-lite` 的 `output`(320000) > `context`(256000)**，照抄上游的结果，发请求前必须 `max_tokens = min(output, context)`，否则必然 400。
4. **`rate = 0` 只表示「文档标免费」**。宿主语义里 `rate` 0 是「未给折扣」，判免费只能看 `free` 布尔；本目录保证 `free ⇔ rate === 0`，测试双向守着。
5. **`modalities` 别只从 `vision` 位推**。`modelEntry` 现在写的是 `input: vision ? ["text","image"] : ["text"]`，会丢掉上游文档里的音频/文件输入：7 条 `in:audio`（如 `qwen/qwen3.8-omni-flash`、`xiaomi/mimo-v2.6-pro`、`bytedance/doubao-seed-2-1-lite`）与 1 条 `in:file`。要精确就再读 `note` 里的 `in:audio` / `in:file` 标记，视觉之外不进 `vision` 位（`vision` 只表达图/视频）。

## 8. 维护：怎么重新生成

目录是**抓取快照**，不是长期契约。七牛上新/改限制后必须整体重抓，别手改单条：

1. 抓上游：匿名 `GET https://api.qnaigc.com/v1/models`，原始 JSON 存 `research/models-live.json`；
2. 抓文档：`GET https://www.qiniu.com/ai/models`，从 `<script id="__NEXT_DATA__">` 取 `props.pageProps.models`；
3. 按 id join 两源（91/91 必须全命中；`context_length`/`max_tokens`/`service_status` 差异必须为 0，否则先查清谁过期）；
4. 用 §3 的判定式生成 `plugin/src/catalog.mjs`（生成期算完能力位，运行期零推断）；
5. 同步更新 `docs/model-catalog.md` 的表格与计数、`catalog.mjs` 里的 `UPSTREAM_FACTS`、`plugin/tests/catalog.test.mjs` 顶部的实测常量（三者必须一起改，测试会互相校验）；
6. 跑测试：`bun test plugin/tests/catalog.test.mjs`（本机没有 node，只有 bun 1.4.5；`node:test` / `node:assert` 由 bun 兼容）。

测试的取向是**快照回归**：21 个用例里有 12 个断言着死数字（91 / 6 / 1 / 4 / 45 / 81 / 5 / 1 / 45）。七牛哪天加模型，测试必须红一次提醒重抓，而不是让目录悄悄漂移。
