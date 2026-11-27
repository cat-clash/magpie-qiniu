# 排错

格式统一是**现象 → 定位 → 处理**。概念性问题看 [FAQ](./faq.md)，上游事实看 [CONTRACT.md](../CONTRACT.md)。

## 0. 先看这三个地方

| 观测面 | 怎么看 | 能看到什么 |
|---|---|---|
| 安装脚本输出 | 重跑 `.\install.ps1 -DryRun` / `./install.sh --dry-run` | 前缀 `==>` 动作、`[ok]` 通过、`[!]` 警告、`[x]` 失败（行首 3 空格的是细节） |
| 插件注册状态 | `magpie plugin` / `magpie plugin list` | 是否列出 `qiniu-ai`、模型条数、是否 signed in、加载失败原因 |
| 对话与用量 | `magpie provider test qiniu-ai <model>`、`magpie quota`、供应商账号卡片 | 一次请求的真实错误；面板里的额度文本与百分比 |

日志里所有 Key / AK / SK / 签名都已过 `redact()`，可以直接贴到 issue 里，但请再肉眼过一遍。

## 1. 安装脚本退出码

### 退出码 `1` —— 没找到 magpie，或参数不认识

- **现象**：最后一行是 `[x] 未找到 magpie 可执行文件` 或 `[x] 未知参数: --xxx`，什么都没改动。
- **定位**：
  ```powershell
  Get-Command magpie -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
  ```
  ```bash
  command -v magpie || echo "not on PATH"
  ```
  参数拼错同样落在这里（安装器只认 `--login/--uninstall/--force/--dry-run/--yes/--no-color/--help` 及它们的单横线写法）。
- **处理**：magpie 在但不在 PATH → 用完整路径启动一次，或把它的目录加进 PATH；确实没装 → 先装 magpie 宿主。**不要**猜别的参数名，本仓库没有 `--doctor` / `--mirror` / `--ref`。

### 退出码 `2` —— 源码或包名不对 / `plugin add` 失败

- **现象**：`[x] 未找到插件源码: <路径>`、`[x] package.json name 不是 magpie-qiniu-lite`，或 `plugin add` 报错。
- **定位**：确认目录结构是 `magpie-qiniu\plugin\`（`package.json` + `index.mjs` + `src\` 都在）。脚本从自身所在目录取源码，**不会**去别处找。PowerShell 里若报 `禁止运行脚本`，那是执行策略，不是本仓库的问题。
- **处理**：补齐目录后重跑；执行策略用 `powershell -ExecutionPolicy Bypass -File .\install.ps1`。若 `plugin add` 本身失败，直接手跑一次看完整报错：
  ```
  magpie plugin add <仓库绝对路径>\plugin
  ```
  路径含空格时加引号。

### 退出码 `3` —— 装完了但 `plugin list` 里没有 `qiniu-ai`

- **现象**：`[x] 复核失败：plugin list 里没有 qiniu-ai`。
- **定位**：`magpie plugin list` 手动看一眼。三种可能：插件目录里没有 `package.json` 的 provider 声明、宿主加载插件时抛错（列表里会写失败原因）、magpie 刚写入还没被宿主扫到（宿主每秒轮询一次注册表，等一秒就够）。
- **处理**：加载报错就按报错修（Node/Bun 版本低于 22、`index.mjs` 语法错都会在这里现形）；确认无误再跑一次 `.\install.ps1 -Force` / `./install.sh --force`。如果列表里出现了 `qiniu-ai` 但标着"由别的插件提供"，说明同名 id 被占用，见 [FAQ Q22](./faq.md)。

## 2. 鉴权类

### `auth_api_key_invalid` / `Invalid API key`（HTTP 401）

- **现象**：对话立刻失败，响应体形如：
  ```json
  {"error":{"message":"Invalid API key","type":"authentication_error","code":"auth_api_key_invalid"}}
  ```
  宿主把这条账号标成需要重新登录。
- **定位**：`magpie plugin` 看是否 signed in；确认这把 Key 是不是七牛的 `sk-`（不是别家拼错的），确认 `baseUrl` 指向 `https://api.qnaigc.com/v1`（改成别家域名后当然会 401）。
- **处理**：`magpie plugin login qiniu-ai` 重填。Key 在控制台被删/停用过就去重新生成一把。**注意**：这把 Key 一旦被上游撤销，重新登录是唯一出路，插件不会替你绕过。

### `invalid ak/sk sign`

- **现象**：AK/SK 登录成功，但一打开用量面板或让插件建 Key 就报 `invalid ak/sk sign`。
- **定位**：这条来自**管理接口**（`api.qiniu.com/billing-api/*`、`/v1/apikeys`），不是推理接口。三个高频原因：① 把 `sk-` 填进 AK 栏；② AK/SK 之间有冒号或多余空格；③ 签名过期 —— 上游口径是**签名有效期 15 分钟**，机器时钟漂移超十几分钟就会稳定复现。
- **处理**：AK/SK 分开填（控制台"对象存储密钥"处，不是 API 密钥处），别加冒号；校准时钟；AK/SK 本身错了就到控制台确认这对密钥还有效。用量接口只接受 `sk-` 或 AK/SK 签名，不接受临时 Key（见下一条）。

### `temporary key is not allowed`（401）

- **现象**：对话一切正常，用量面板却报这一句。
- **定位**：你登录用的是 `tk-` 开头的**临时 Key**。推理接口认它，`/v3/stat/*` 与 billing 接口不认。
- **处理**：用量面板要工作就必须换正式 `sk-` Key，或用 AK/SK 登录让插件自己签发一把（`autoCreateKey`，默认开）。这不是 bug。

### `missing authorization header` / `invalid api key or aksk`

- **现象**：用量或余额接口直接 401。
- **定位**：前者是没带 `Authorization`（账号被清掉了还没重登）；后者是 Key / AK 组合本身无效。
- **处理**：重新登录；仍报后者就逐项核对控制台里这把密钥是否还在、是否被禁用。

### `sign_in_required`（401，由插件产生）

- **现象**：请求还没出本机就返回 401，`error.type = "sign_in_required"`，并带 `X-Magpie-Sign-In: expired`。
- **定位**：`getAuth()` 拿不到凭据 —— 没登录，或宿主侧账号被删。
- **处理**：`magpie plugin login qiniu-ai`。

## 3. 额度与余额

### `insufficient_quota` / 402（余额或资源包不足）

- **现象**：上游返回 402，插件把它改写成 429，`message` 是中文提示（余额 / 资源包不足），`type = "insufficient_quota"`。
- **定位**：`magpie quota` 或账号卡片看余额与资源包；上游 `message` 会区分余额不足与资源包不足。
- **处理**：充值或买资源包。**恢复时机**：上游扣费判定随入账恢复，面板数字最长再滞后约 15 分钟，插件侧缓存默认 30 秒。详见 [FAQ Q17](./faq.md)。
- **注意**：402 会被插件**改写成 429 + `retry-after: 900`**（`code = balance_insufficient`），这样宿主会去切下一个账号而不是把整家供应商当故障；只有 403/503 那类"模型不可用"才会被改成 404。

### `Account is suspended due to billing status`（403，账号停用）

- **现象**：403，body 形如
  `{"error":{"message":"Account is suspended due to billing status (request_id: chatcmpl-…)","type":"access_denied_error","code":"account_billing_suspended"}}`，
  GUI 账号卡片同时写着"现金余额 ¥-x.xx（请充值或领资源包）"。
- **定位**：**账号级欠费停用**，不是 Key 的问题，也不是限流。余额为负（哪怕只负 ¥1.23）上游就会整号停掉；这把 Key 换到别处也一样 403。
- **处理**：充值或领资源包，等账单结清（上游约 20 分钟解除）。插件把它改写成 **429 + `retry-after: 1200`**（`code = arrears`），宿主会退避而不是标记账号需要重登 —— 2026-11-27 之前这条规则没覆盖这个文案，插件会原样透传裸 403。
- **验证**：`magpie quota qiniu-ai` 看"现金余额"窗口；余额转正后 `magpie provider test qiniu-ai <model>` 应回到 200。

### `Request not allowed`（403，欠费）

- **现象**：403，body 里 `message` 为 `Request not allowed`。
- **定位**：上游把这个返回给**账号处于欠费状态**的请求。
- **处理**：先确认是否充值中 / 有未结算账单，再确认这把 Key 是否被停用。**这是账号状态，不是 Key 错误**，所以别急着删 Key。

### `apikey monthly quota exceeded`（403）

- **现象**：403，`message` 含 `apikey monthly quota exceeded`。
- **定位**：这把 Key 的**月度配额**用完了，不是账号没钱。用 AK/SK 登录后能在用量面板看到 Key 限额窗口（有分母，会显示百分比）。
- **处理**：三条路：等下个月重置；提高这把 Key 的限额；或让插件另开一把新 Key（`autoCreateKey` + AK/SK 登录）。限额改动上游有 0～30 秒生效延迟，改完别只等一秒就下结论。

## 4. 模型可用性

### `the price of the model is not set`（上游 503 → 插件 404）

- **现象**：某个模型一调就失败；插件侧看到的是 **404** + `x-magpie-sign-in: kept`，`error.type = "not_available_error"`。
- **定位**：上游对这个模型**还没配价格**（常见于新上架/灰度模型）。原状态码是 503，插件把它归一成 404，是为了让宿主把它当"模型不可用"直接换下一个，而不是当服务故障去切供应商。
- **处理**：换同族别的版本（如 `-latest` 换成带日期的快照，或反过来）；在 magpie 模型列表里把这个标成 `deprecated` 的条目隐藏。这**不是**你的 Key 有问题。

### `model … is not available in your assigned model groups`（403）

- **现象**：403，`message` 含 `is not available in your assigned model groups`。
- **定位**：这把 Key 被分到某个模型组，目标模型不在组里。
- **处理**：控制台调整 Key 的模型组，或换一把不设限的 Key。插件同样把它归为 404 `not_available_error`，不会把账号标成过期。

## 5. 限流

### `UID rate limit reached for TPD (oversea) for UID`（429）

- **现象**：429，`message` 含 `UID rate limit reached for TPD`（也可能是 RPM / TPM 字样）。
- **定位**：TPD = Tokens Per Day，**按账号**限的日 token 量，不是按 Key。RPM / TPM 是分钟级。`magpie provider test qiniu-ai <model>` 单条能过、批量并发就 429，基本就是撞了这一层。
- **处理**：把 option `maxConcurrency` 调小（默认 4，范围 1..1000，宿主侧的每-provider 上限会覆盖它）；长任务改串行或分时段跑；确实需要更高配额，联系七牛客服提升。插件不重试、不排队 —— 429 原样交给宿主的退避与故障切换。
- **插件补的 `retry-after`**：上游全站不返 `retry-after`（实测 0 个），所以插件自己算一个再交给宿主 —— `TPD` → 下一个 **+08 零点**（夹在 60..86400 秒），`RPM`/`TPM` → **60 秒**，`code` 分别是 `account_daily_quota` / `account_rate_limited`。这样宿主不会用固定兜底把账号锁到天级。注意 TPD 是**按账号**算的：换 Key 无效，只能等日界或降并发。

### 用量面板报速率限制 / 数字不刷新

- **现象**：面板里出现错误文本，或反复打开都看不到新数据。
- **定位**：`/v3/stat/usage` 同 IP **5 req/s**。多账号共用一个出口 IP 时很容易超。插件已有 30 秒缓存（`usageCacheMs`，下限 5000）与回溯天数限制（`dailyUsageDays`，默认 7，夹紧 1..31）。
- **处理**：把 `usageCacheMs` 调**大**（比如 120000），回溯天数调小；不要为了"看起来更实时"把它压到 5000 又抱怨被限流。查询跨度也有硬限制：`day` ≤31 天、`hour` ≤7 天，超限直接报错（上游对明细最长只查 100 天）。

### 插件回 `breaker_open`（429，本地熔断）

- **现象**：`error.code = "breaker_open"`，`message` 里带「本地熔断」，`retry-after` 指向冷却结束时刻；上游日志里这段时间**没有**新请求。
- **定位**：这是插件自己拦的，不是七牛拦的。该账号连续 `401/402/403/429` 达到 `breakerThreshold`（默认 5）次 → 本地 open；冷却 `breakerCooldownMs`（默认 30 分钟）后进入 half-open，放行一个探测请求：成功关闭，失败则翻倍退避（30min → 1h → 2h → 4h → 8h 封顶）。
- **为什么这么设计**：TPD 是日窗口、欠费是结清才恢复，这两种状态下宿主原地重试只会白撞上游、把限流窗口拖得更长。
- **处理**：
  - 想立刻恢复：`magpie provider off qiniu-ai` 再 `on`（进程内状态随之重建），或直接换成另一个账号；
  - 想调松：把 `breakerThreshold` 调大、`breakerCooldownMs` 调小；
  - 想关掉：`breakerThreshold: 0`；
  - 想知道现在开着哪些桶：看 `magpie plugin diagnostics magpie-qiniu-lite` 的 `breaker.open`。
- **注意**：熔断状态只在内存里，**不落盘** —— 进程重启即清空，不会出现「配置文件把账号永久锁死」。

### 请求明明不多却被拉长间隔（`pacingMinMs`）

- **现象**：并发批量打同一个账号时明显变慢，但都成功。
- **定位**：出站节奏闸按 `pacingMinMs`（默认 800ms）+ `pacingJitterMs`（默认 400ms）把同一账号的相邻请求拉开，这是**故意的**，为了让每分钟的请求分布先落进 RPM/TPM 窗口。
- **处理**：确认自己没撞过 TPM 再调小（`pacingMinMs: 0` 只关间隔闸，抖动仍生效）；不同账号各有独立时间轴，互不拖累。

### 想查「今天还剩多少 TPD」

- **先说结论**：**剩余量查不到，已用量查得到。** 上游不公布 TPD 的日上限，控制台也没有这个数字，插件不会编一个分母出来；`429 UID rate limit reached for TPD` 就是到顶的信号本身。
- **在哪看**：
  - 用量面板（`magpie quota qiniu-ai` 或账号卡片）顶部的**「今日 TPD」窗口**：`已用 X tokens（含缓存 Y）；上游不公布日上限，429 TPD 即到达。重置于下一个 +08 零点`。
  - 命令行走仓库根的 `node tools/doctor.mjs`，第 4 项「今日 TPD」给同一个数，顺带把 Key 有效性 / 余额 / options 自检一起查了。
- **口径**：`/v3/stat/usage` 的 `days=1` 序列正好覆盖「+08 日界 0 点 → 现在」，与上游 TPD 的日界一致；上游单位是 kToken，插件 ×1000 换回 token。
- **处理**：撞到 429 TPD 只能等下一个 +08 零点（**TPD 按账号计，换 Key 无效**）；不想撞就调小 `maxConcurrency`、拉大 `pacingMinMs`，把日用量控制在配额以内。窗口数字要实时就别把 `usageCacheMs` 调太大 —— 面板默认 30 秒缓存。

### 模型自己消失了（健康快照）

- **现象**：某个模型昨天还在模型列表里，今天不见了；或对话里选它直接没得选。上游 `/v1/models` 里这个模型仍然存在。
- **定位**：插件的**进程内模型健康快照**（`src/health.mjs`）。同一个模型连续「模型级」失败到 `failureThreshold`（默认 3 次）就被标记 dead，`provider.models` 钩子把它的 `status` 改成 `deprecated` —— 宿主不显示也不路由 deprecated 模型，于是它在列表里「消失」。记的只是**模型级**失败：上游 503 未标价（插件改判 404 `model_not_priced`）、403 不在订阅组（404 `model_out_of_scope`）、模型不存在这类。账号级失败（401/402/403/429）**不**记进快照，那归熔断器。
- **恢复**：dead 状态保留 `ttlMs`（默认 30 分钟），过期后插件重新给这个模型机会（失败从 1 重新数）；一次成功也立即清零恢复。快照只在内存里，**重启宿主进程即清空**。
- **确认**：`magpie plugin diagnostics magpie-qiniu-lite`（插件 spec 名，provider 块是 `qiniu-ai`）里的 `modelHealth`，能直接看到 `dead` 名单与每个模型的失败计数 / 最近状态码；或跑仓库根的 `node tools/doctor.mjs --probe-models 1 --models <模型id>`，若上游实际 200 而宿主列表里没有它，就是快照判死（等 `ttlMs` 过期或重启宿主即可恢复）。

## 6. 流式与超时

### 流式回答中途断掉

- **现象**：SSE 吐了一半停住，或宿主报连接被重置。
- **定位**：逐层排：
  1. **先看是不是被算成"可用性问题"**：断流后插件给的是 5xx/网络错误 passthrough，不会带 `x-magpie-sign-in`，因此账号不会被标过期。如果账号被标了，说明上游实际返的是 401，回到第 2 节。
  2. **超时**：option `chatTimeoutMs` 默认 600000（下限 30000）。长思考模型 + 大上下文很容易吃掉几十分钟，把"超时"误当成"断流"。
  3. **首 token 就慢**：推理网关排队与模型冷启动都会表现为长时间无输出，不是插件截断。
  4. **代理**：企业代理对 `text/event-stream` 做缓冲，会让流式看起来"一次性到达"或干脆超时。
- **处理**：调大 `chatTimeoutMs`；换短上下文复现一次；直连测试 `magpie provider test qiniu-ai <model>` 并记录耗时；插件对上游响应体**原样透传**，不做二次封装，所以断在哪一层可以用同一条 curl 对照。

### 想确认插件有没有改写我的请求体

- **定位**：本插件对请求体只做一件事 —— 注入 `prompt_cache_key`（见 [CONTRACT §5](../CONTRACT.md) 的注入条件）。其余字段原样上行。`extraHeaders` 只影响 header，`modelOverrides` 只影响模型 id 映射。
- **处理**：把 option `promptCache` 设为 `false` 再复现一次 —— 这是唯一会被插件动到的请求字段。

## 7. `X-Magpie-Sign-In` 的含义

这是**插件与宿主之间的约定**，不是上游返回的头。宿主在转发给插件之前会把它剥掉，插件再基于自己的判断设置：

| 头值 | 含义 | 宿主行为 | 插件什么时候设 |
|---|---|---|---|
| `expired` | 这把凭据真的被拒了 | 标记该账号需要重登；**无论状态码是 401/403/502 都按被拒处理** | 上游 401、或 `getAuth()` 拿不到凭据 |
| `kept` | 这个 401/404 跟凭据无关 | 不动账号状态 | 模型不可用那类归一成 404 的路径 |
| `renewed` | 凭据刚刷新过 | 清除之前的过期标记 | 本插件没有 `auth.refresh` 钩子，**不会设这个值** |

**没有这个头的 401** 宿主也会分类：如果响应体只说"模型不可用"（`model … not available` / `model_not_found` / `模型不支持`）且完全没提到 token / key / session，宿主按 `kept` 处理；一旦同时提到模型和凭据问题，就仍然标记账号。

因此：

- **现象**：明明只是模型选错了，账号却被标成需要重登 → 说明上游那条错误的措辞里混进了 token/key 字样。把原始 body 贴到 issue 里，插件的判定条件需要扩。
- **现象**：Key 被删了账号却没被标记 → 检查是不是走到了 403 那几条（欠费/配额/模型组）；那些路径**故意**不标记账号，因为重登解决不了。

## 8. 插件装了但不出字（宿主侧）

**先 check，后 doctor。** 顺序不能反：check 一条网络请求都不发，秒回、零费用，先把「本机装对了没」
这件事排除掉；doctor 每条结论都要真的打一次上游，用来查账号。

```powershell
node tools/check.mjs      # 宿主侧：插件条目 / provider 开关 / 账号 / 代理 / 仓库 / Node
node tools/doctor.mjs     # 账号侧：Key 有效性 / 余额 / TPD / options
```

- check 里有 `✗` → 先照它给的 `→ 修复：…` 处理，多数情况到这一步就结束了；
- check 全 `✓` 还不出字 → 问题在账号侧，转 doctor。

四个高频成因：

### 8.1 provider 被置成 off（最常见）

- **现象**：`magpie plugin list` 里 `qiniu-ai` 在、也 signed in，但对话不出发，请求全部 404。
- **为什么**：`magpie plugin off/on` 和「重启 magpie」都会把这个 provider 置回 `off`（宿主行为，
  不是插件 bug）。
- **确认**：
  ```powershell
  node tools/check.mjs        # 「provider 开关」一行标 ✗ 就是它
  magpie provider ls          # 看 qiniu-ai 当前是 on 还是 off
  ```
- **处理**：`magpie provider on qiniu-ai`。装/换插件之后固定补这一步。

### 8.2 账号为空

- **现象**：check 报 `✗ 账号：plugin-auth.json 里没有 qiniu-ai 或 qiniu-ai@... 的条目`；
  对话直接 401 `sign_in_required`。
- **确认**：
  ```powershell
  magpie plugin list          # 有没有 "signed in as ..."
  node tools/doctor.mjs       # 第 1 项「凭据」会说没有可用 Key
  ```
- **处理**：`magpie plugin login qiniu-ai`，填一把正式 `sk-` Key，或走 AK/SK。

### 8.3 AK/SK 登录了但没签发 `sk-` Key

- **现象**：能登录、用量面板也有数，对话却 401 / `auth_api_key_missing`。
- **为什么**：AK/SK 只是签名材料，日常推理要的是插件用 `POST /v1/apikeys` 自动签发的那把 `sk-` Key
  （option `autoCreateKey`，默认开）。签发这一步失败，账号上就只剩签名能力。
  三个常见原因：AK/SK 填反、AK/SK 与 `sk-` 混填、本机时钟漂移超过签名有效期（上游 15 分钟）。
- **确认**：
  ```powershell
  node tools/check.mjs        # 「账号」一行若写「N 个账号，但都没有 key 字段」= 没签出来
  node tools/doctor.mjs       # 「凭据」写的是 AK/SK 而不带 sk- Key 摘要；「Key 有效性」是不是 401
  ```
- **处理**：到控制台确认填的是**对象存储密钥**那对 AK/SK（不是 API 密钥页），别加冒号、别带空格；
  校准本机时钟；或者干脆直接填一把正式 `sk-` Key 登录 —— 最快也最省事。

### 8.4 代理把请求绕到海外

- **现象**：check 的「代理」一行 `⚠`；请求超时 / 502 / TLS 报错，而裸跑
  `curl https://api.qnaigc.com/v1/models` 是通的（或反过来，带上代理才失败）。
- **为什么**：`api.qnaigc.com` / `api.qiniu.com` 都是国内网关，走海外代理只会更慢、更容易被断；
  反过来把 `proxy` 写成 `direct` 时，本机靠代理才能到的海外端点会一直超时。
- **确认**：
  ```powershell
  node tools/check.mjs        # 「代理」一行回显 settings.json 里的 proxy（只到 host:port）
  ```
  也可以直接看 `~/.config/magpie/settings.json` 的 `proxy` 字段。
- **处理**：国内端点不该走海外代理 → 该条链路上用 `direct` 或让代理自己分流
  （把 `api.qnaigc.com`、`api.qiniu.com` 加进代理软件的分流规则）；改完重跑
  `magpie provider test qiniu-ai <model>` 对照一次。本插件不读任何代理相关的 options，
  它跟宿主 / `settings.json` 走。

## 9. 不知道选哪个模型

别翻 [model-catalog.md](./model-catalog.md) 逐行比价格和上下文了，跑 score：91 个模型按用途打分，
输出 `0..1` 的总分与四维分（上下文窗口 / 输出上限 / 价格 / 能力）。

```powershell
node tools/score.mjs --profile coding             # 写代码
node tools/score.mjs --profile cheap --limit 10   # 找免费 / 最便宜的
node tools/score.mjs --exclude <模型id>,<模型id> --profile balanced   # 排除掉已知不可用的再排
```

五档怎么选：

| 你要干的活 | profile | 该看什么 |
|---|---|---|
| 说不清，先找个能打的 | `balanced` | 四维均衡的前几名 |
| 写代码、跑带工具的 agent | `coding` | 上下文、`toolCall`、输出上限 |
| 整仓读码 / 长文档问答 | `long-context` | 上下文窗口是否够放下整包文件 |
| 图片 / 截图 / PDF | `vision` | `vision` 是硬门槛，其他维度再高也替代不了 |
| 批处理 / 先试试水 | `cheap` | 价格，`free` 优先 |

两条硬提醒：

- **健康快照判死的模型不要选**。插件进程内记「模型级」失败（未标价 503 → 404、不在订阅组 403、
  模型不存在），同一模型连续 3 次就把 `status` 改成 `deprecated`，宿主既不显示也不路由。这类模型
  在 score 里分数可能仍然很高，但调了必失败。挑之前先看
  `magpie plugin diagnostics magpie-qiniu-lite` 的 `modelHealth.dead`；等 `ttlMs`（默认 30 分钟）
  过期，或重启宿主进程立即清空。
- **catalog 里的 `max_tokens=0` / `context_length=0` 是脏数据**（6 条 / 1 条），不是「零能力」，
  score 已按默认上限兜底；看到这些模型没被排到最后，是故意的。

## 10. 面板与显示

### 用量面板一片空白 / 只有文字没有进度条

- **定位**：见 [FAQ Q13](./faq.md)。上游没给分母的窗口（token 累计量、预付钱包余额、资源包）本来就只出 `display` 文本或 `balance`，**有分母的 Key 限额才画百分比**。宿主规则不允许用 0 表示"未知"。
- **处理**：没有需要处理的。要更多数字，用 AK/SK 登录（会多余额、资源包、Key 限额三块）。

### 面板数字和账单差很多

- **定位**：`/v3/stat/usage/apikey/cost*` 是**标准价格**，不含资源包抵扣与折扣；预估账单页本身延迟约 15 分钟；余额单位是**元 × 1e8**（插件已除回去）。时区默认 `Asia/Shanghai`（IANA 名，传错会报"无效的 timezone"）。
- **处理**：以财务中心为准；对比时把资源包抵扣单独算。

## 11. 还是不行

带上这四样开 issue（[模板](../.github/ISSUE_TEMPLATE/bug_report.yml) 会要求这五栏）：

1. 环境：OS、magpie 版本（`magpie --version`）、Node/Bun 版本、插件版本（`plugin/package.json` 的 `version`）。
2. 出问题的那一步：安装 / 登录 / 对话 / 流式 / 模型列表 / 用量面板 / 卸载。
3. 你用的参数与 options（`magpie plugin options magpie-qiniu-lite` 现有值的 JSON）。
4. **已脱敏**日志：安装脚本 `-DryRun` 输出 + 上面那条错误响应体。**不要**贴完整 Key，写成 `Bearer sk-****` 即可。

能自己先验证的两件事：跑一遍离线测试（`node plugin/tests/smoke.mjs`、`node tests/e2e/installer.test.mjs`）确认代码本身没坏；换一个模型 id 确认不是可用性问题。
