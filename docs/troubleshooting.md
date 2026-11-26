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

## 8. 面板与显示

### 用量面板一片空白 / 只有文字没有进度条

- **定位**：见 [FAQ Q13](./faq.md)。上游没给分母的窗口（token 累计量、预付钱包余额、资源包）本来就只出 `display` 文本或 `balance`，**有分母的 Key 限额才画百分比**。宿主规则不允许用 0 表示"未知"。
- **处理**：没有需要处理的。要更多数字，用 AK/SK 登录（会多余额、资源包、Key 限额三块）。

### 面板数字和账单差很多

- **定位**：`/v3/stat/usage/apikey/cost*` 是**标准价格**，不含资源包抵扣与折扣；预估账单页本身延迟约 15 分钟；余额单位是**元 × 1e8**（插件已除回去）。时区默认 `Asia/Shanghai`（IANA 名，传错会报"无效的 timezone"）。
- **处理**：以财务中心为准；对比时把资源包抵扣单独算。

## 9. 还是不行

带上这四样开 issue（[模板](../.github/ISSUE_TEMPLATE/bug_report.yml) 会要求这五栏）：

1. 环境：OS、magpie 版本（`magpie --version`）、Node/Bun 版本、插件版本（`plugin/package.json` 的 `version`）。
2. 出问题的那一步：安装 / 登录 / 对话 / 流式 / 模型列表 / 用量面板 / 卸载。
3. 你用的参数与 options（`magpie plugin options magpie-qiniu-lite` 现有值的 JSON）。
4. **已脱敏**日志：安装脚本 `-DryRun` 输出 + 上面那条错误响应体。**不要**贴完整 Key，写成 `Bearer sk-****` 即可。

能自己先验证的两件事：跑一遍离线测试（`node plugin/tests/smoke.mjs`、`node tests/e2e/installer.test.mjs`）确认代码本身没坏；换一个模型 id 确认不是可用性问题。
