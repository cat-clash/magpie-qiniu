# magpie-qiniu

把 [七牛云 AI 推理网关](https://www.qiniu.com/ai/models)（`api.qnaigc.com`）接进 [Magpie](https://usemagpie.ai/)。插件源码就在本仓库 `plugin/`，安装只需三步，不联网、不下载任何东西。

[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-1f6feb.svg)](#快速开始)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](./plugin/package.json)

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

```bash
# macOS / Linux
./install.sh
```

## 仓库结构

```
.
├── install.ps1              Windows 安装脚本（PowerShell 5.1 / 7）
├── install.sh               macOS / Linux 安装脚本
├── CONTRACT.md              工程契约（上游事实、钩子签名、options）
├── plugin/                  插件本体
│   ├── index.mjs             钩子装配
│   ├── package.json          包名 magpie-qiniu-lite
│   ├── README.md             插件内部结构与契约要点
│   ├── src/                  配置 / 签名 / 目录 / 用量 / 转发 / 脱敏
│   └── tests/                单测（node:test，全部不联网）
├── tests/e2e/               假 magpie 桩 + 安装脚本端到端测试
├── docs/
│   ├── faq.md               常见问题
│   └── troubleshooting.md   现象 → 定位 → 处理
├── research/                上游实测记录（不参与安装，仅供校对）
├── _tools/verify.mjs        交付验收脚本
└── .github/
    ├── ISSUE_TEMPLATE/      issue 模板
    └── workflows/ci.yml     CI
```

## 安装

**方式一：GitHub 直装（推荐，最省事）**

```
magpie plugin add github:cat-clash/magpie-qiniu
```

仓库根级 `index.mjs` / `package.json` 已按 magpie 的 `github:` 安装约定配置（入口转发到 `plugin/` 子目录），装完 `magpie plugin list` 复核 `qiniu-ai` 在列即可。之后插件更新只需 `magpie plugin remove qiniu-ai` 再重新 add 同一地址（或按 magpie 的更新机制刷新），始终拿到 GitHub 上的最新版。

**方式二：本地脚本安装**（仓库克隆到本地后）

脚本做三件事：

1. 校验 `plugin/package.json` 存在且包名是 `magpie-qiniu-lite`；
2. 定位 `magpie`（PATH → 常见安装目录 → 环境变量 `MAGPIE_BIN`）；
3. `magpie plugin add <仓库内 plugin 目录>`，再用 `magpie plugin list` 复核 `qiniu-ai` 在列。

**退出码**：

| 码 | 含义 |
|---|---|
| `0` | 成功；或用户取消；或 `--help` |
| `1` | 找不到 `magpie` 命令，或传了未知参数 |
| `2` | 插件源码缺失 / 包名不符 / `plugin add` 失败 |
| `3` | 装完后 `plugin list` 里没有 `qiniu-ai`（复核失败） |

安装过程本身**不发任何网络请求**：没有下载、没有解压、没有远程代码。

## 本插件没有每日签到

**这是刻意的，不是漏掉了。**

七牛云 AI 推理是**按量付费的 API Key**（正式 `sk-` Key，余额 / 资源包扣减），上游没有任何「每天点一下送额度」的接口或机制。Magpie 的 `auth.checkin` 钩子只服务于「每日签到送额度」这类供应商（见[官方插件文档](https://usemagpie.ai/docs/plugins)），在这里没有对应的上游动作可以调。

所以：

- `plugin/` 里**不存在** `checkin` 钩子、不存在签到模块、不存在签到状态落盘；
- 没有 `dailyCheckin` / `checkinHour` 这类 options；
- 单测里有一条断言专门守住这一点 —— 装配结果出现 `auth.checkin` 直接判失败（见 [CONTRACT.md](./CONTRACT.md) §0）；
- 新用户额度走的是**注册 / 首次创建 API 密钥时发放的免费资源包**（首次创建密钥即激活 300 万 Token 资源包），一次性发放，与签到无关，也不需要插件做任何事。

如果哪天七牛真的上线了签到类活动，那是新需求，请先在 [issue 里说明](https://github.com/search?q=magpie-qiniu)再实现。

## provider id：`qiniu-ai`，与社区插件的冲突说明

上游社区里已经有 `github:tk103331/magpie-qiniu-plugin`，它用的是 **`qiniu`** 这个 provider id。本插件用 **`qiniu-ai`**，因此：

- **两者可以共存**：id 不同，magpie 把它们当成两个供应商，各自的模型目录、账号、用量互不干扰；
- 想在本机上让两个插件都保留，什么都不用做；
- 如果你更想用 `qiniu` 这个名字（例如为了沿用已有会话里的供应商选择），得先把占着这个名字的那个卸掉，再把本插件挂到该 id 上（**需要宿主支持改挂 id**，即 `magpie plugin use <路径> <id>` 这条路径可用）：

  ```bash
  magpie plugin rm magpie-qiniu-plugin          # 先释放 qiniu 这个名字
  magpie plugin use ./plugin qiniu              # 如宿主支持；不支持就沿用 qiniu-ai
  ```

- 注意宿主行为：两个已安装的插件登录同一个 id 时，只有其中一个真正提供服务（默认是后添加的那个）。这不是 bug，是宿主的选取规则；用 `magpie plugin use <名字> <id>` 可以改选。本插件默认用 `qiniu-ai`，正是为了绕开这场竞争。
- 你也可以通过 options 的 `providerId` 自己换一个名字（只允许 `[a-z0-9-]`，见[插件配置](#插件配置)）。

## 插件能力

只列**已经落地**的。机制 / 开销 / 边界分开说。

### 两种登录：`sk-` Key 与 AK/SK

**机制**：`auth.methods` 给两个入口。填 `sk-` 开头的正式 API Key 即可用；也可以填七牛云的 AK/SK，插件按七牛标准签名（`Authorization: Qiniu <AccessKey>:<EncodedSign>`）调账号级接口，并用 `POST /v1/apikeys` **自动签发一把 `sk-` Key** 用于日常推理（option `autoCreateKey`，默认 `true`）。签出来的 Key 通过 `client.auth.set` best-effort 写回账号存储一次，写回失败就只在内存里留着，不影响本次请求。

**开销**：签名按请求现算，不缓存（七牛的签名有效期本身是 15 分钟）；签发 Key 只在账号还没有 `sk-` 时发生一次；没有任何后台定时器。

**边界**：`tk-` 开头的临时 Key 可以打推理接口，**不能**打 `/v3/stat/*` 用量与费用接口（上游直接 401 `temporary key is not allowed`），这种情况下用量面板会给出明确提示而不是空面板。AK/SK 的写回是全量替换，所以只在签发新 Key 时动一次，别的地方绝不改账号存储。


### 批量导入 Key

**机制**：`auth.import` 接受一段文本，一次粘多个凭证 —— 每行一个 `sk-` Key，或 `AK:SK` / `AK SK`（可带备注，形如 `备注, AK SK`），也接受整段 JSON 数组或 `{keys:[…]}`；`#` / `//` 开头的注释行会被忽略，重复凭证自动去重。

**开销**：纯本地解析，不联网；导入时按 `sk-` 打 `/v1/models` 验证一把（最多并发 4 条），失败的行逐条给出原因，不阻断其他行。

**边界**：AK/SK 行会走与手动登录相同的 AK/SK 路径（签名打余额接口 + 自动签发 `sk-`），失败那一行只记 note、不影响其余 Key 的导入。
### 模型目录：静态表 + `/v1/models` 动态合并

**机制**：`config` 钩子里写死一张静态模型表，**未登录也有内容**（否则 magpie 的供应商页是空的）。登录后 `provider.models` 拉 `GET /v1/models`，把上游条目归一后与静态表合并（`showAllModels`，默认 `true`），`modelOverrides` 可以对单个 id 覆写局部字段。

**开销**：动态拉取带 TTL 缓存；拉取失败或上游返回异常时，`provider.models` **原样返回传进来的 `provider.models`**（引用不变），绝不返回半张表。

**边界**：`/v1/models` 的 `max_tokens` 可能是 `0`（表示上游没给），插件必须回退到默认值 —— **绝不会把 `limit.output` 写成 0**。`service_status` 目前只确认了 `available`，其余取值一律标成 `status:"deprecated"` 隐藏（magpie 不显示 deprecated 模型）。五个模态键显式写布尔，不靠省略表达「不支持」。

### 用量面板

**机制**：`auth.usage` 汇总五路上游数据 —— token 序列（`/v3/stat/usage`）、费用与明细（`/v3/stat/usage/apikey/cost`、`cost-detail`）、逐请求日志（`/v2/stat/export_log`）、余额与资源包（`api.qiniu.com/billing-api/v1/account/balance-overview`、`respack/list`）、Key 限额（`/v1/apikey/quota/:api_key`）。`sk-` 账号看这一把 Key 的用量；AK/SK 账号能看账号级（全 Key）余额与用量。

**开销**：`usageCacheMs`（默认 30 秒，下限 5 秒）一层缓存 + 同 IP **5 req/s** 的上游限流；`granularity=day` 跨度夹紧到 ≤31 天、`hour` ≤7 天；时区默认 `Asia/Shanghai`（必须传 IANA 名）。逐请求日志只保留最近 `REQUEST_LOG_CAP` 条。

**边界**：**上游没给分母，就不写 `used`。** magpie 的文档说得很清楚 —— 不要用 `0` 表示「不知道」。所以上游只给消耗量、不给配额时，面板显示 `display` 文本（例如「本月已用 xx 元」），**不显示百分比**，也不参与路由权衡；真正会卡住账号的窗口才不设 `aside`。余额单位是 **元 × 1e8**，插件除回去再显示。费用口径是**原始标准价格，不含资源包 / 折扣优惠**，和财务中心账单对不齐是正常的。订阅积分没有开放接口，面板里没有它。

### `prompt_cache_key` 注入

**机制**：`loader.fetch` 给聊天请求按请求体算一个稳定的 `prompt_cache_key`（`promptCacheKey(body)`），让同一段对话的上游路由亲和落点一致（option `promptCache`，默认 `true`）。

**开销**：一次 SHA-256 摘要，纯内存，无网络。

**边界**：这只是**上游的会话路由键**，不等于打开了上游显式缓存。七牛的显式缓存走 Anthropic 的 `cache_control`（ephemeral，默认 5 分钟，写入按标准价 125%、命中按 10%），且只有 Claude 系模型真正生效；非 Claude 模型带 `cache_control` 不报错也不生效。插件不代你写 `cache_control`。

### Anthropic `/v1/messages` 透传

**状态**：**上游实测端点存在（POST 返回 401、GET 405），但未用有效 Key 做过端到端聊天验证。**

**机制**：`loader.fetch` 里 `POST **/v1/messages` 与 `chat/completions` 走同一条 `forwardChat`，鉴权头沿用宿主注入的那把 Key。上游文档侧有三处印证：`endpoints.md` 把 `POST https://api.qnaigc.com/v1/messages` 列为兼容接口、`anthropic-chat.md` 给了它的 OpenAPI 描述、`claude-cache.md` 的示例用 `x-api-key: YOUR_API_KEY` 认证（注意与 OpenAI 侧的 `Authorization: Bearer` 不同）。

**开销**：不额外发请求，只是多认一条路径。

**边界**：本机探测确认端点存在（POST 401、GET 405），但没有拿到有效 Key 做一次真实聊天调用，所以这里只承诺「按上游文档转发，不做协议改写」；若实测发现不可用，本节会改成「不支持」并从能力清单里删掉。在此之前也不要把它当成 Claude Code 之类客户端的替代品 —— 推理能力取决于所选模型本身。

### 流式原样透传

**机制**：`stream=true` 的回答，插件**不改写流式正文**，状态码与错误体以外的内容原样交付；只在需要时才动头部，一旦改写正文就必须删掉 `content-length` 与 `content-encoding`（否则宿主解不出来）。

**开销**：零额外缓冲，不聚合成整包。

**边界**：整条请求受 `chatTimeoutMs`（默认 600000 毫秒，下限 30000）约束，超时由 `timeoutSignal` 中断。断流排查见 [docs/troubleshooting.md](./docs/troubleshooting.md)。

### 错误分档

**机制**：把上游那些「看着像认证错、其实是没钱 / 没这个模型」的返回拆开，分给不同的处理：

| 上游 | 插件行为 | `x-magpie-sign-in` |
|---|---|---|
| `401`（Key 无效） | 原样透传，账号被标记需要重新登录 | `expired` |
| `402` 余额 / 资源包不足 | 重写成 `429` + `retry-after: 900`，type `balance_insufficient` | `kept` |
| `403` 且正文含 `is not available` / `model_not_found` / `模型不支持` | 改成 **`404`**，type `model_not_found` | `kept` |
| `503` + `price of the model is not set` | 改成 **`404`**，type `model_not_priced` | `kept` |
| `403` 欠费 / `Request not allowed` / `apikey monthly quota exceeded` | 改成 `429` + `retry-after: 1200`，type `arrears` / `quota_exceeded` | `kept` |
| `429`、`5xx` | 原样交回宿主；402/403 的 429 改写可用 `quotaFailover:false` 关掉 | 不设 |
| 取不到账号（`getAuth()` 抛） | `401` + `sign_in_required` | `expired` |
| `401` + `auth_api_key_missing` | 改 `500` `missing_credential`（配置缺失，不标记账号） | 不设 |
| 其它路径 | `501` + `not_implemented` | 不设 |

**开销**：读错误体前先 `clone()`，**绝不消费掉原 body**（否则宿主拿不到正文）。

**边界**：模型不可用**不能用 401** —— 那会把正常账号标成登录失效。这是这套分档存在的全部理由。文案与状态码的对应细节见 [docs/troubleshooting.md](./docs/troubleshooting.md)。

## 快速开始

前置：[Magpie](https://usemagpie.ai/)（`magpie` 在 PATH，或设 `MAGPIE_BIN`）、Node.js / Bun `>= 22`。

1. 拿 Key：<https://portal.qiniu.com/ai-inference/api-key> → 创建 API 密钥。
   首次创建密钥会**激活 300 万 Token 的免费额度资源包**（一次性发放，见[上文](#本插件没有每日签到)）。复制那串 `sk-` 开头的正式 Key。
2. 装插件：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Login
   ```

   ```bash
   chmod +x install.sh && ./install.sh --login
   ```

    `-Login` / `--login` 会在装完后直接进入 `magpie plugin login qiniu-ai`，终端里选 `sk-` Key 或 AK/SK 方式（`sk-` 值填你在控制台创建的正式 Key，形如 `sk-` 后跟一长串字母数字）。
3. 确认已注册：

   ```bash
   magpie plugin list
   # qiniu-ai (Qiniu AI Lite, <N> models)  signed in as <你的账号>
   ```

   `<N>` 是当前生效的模型条目数 = 静态目录与 `/v1/models` 合并后的结果，登录与否、上游是否新增模型都会影响它，别拿这个数字判断装没装上。
4. 打一发最小请求：

   ```bash
   magpie provider test qiniu-ai <model>     # 只测指定模型；不带模型名则每种 API 发一个很小的请求
   magpie quota                              # 看用量面板有没有真的读到数
   ```

## 参数

两端等价，`install.ps1` 用 `-Xxx`，`install.sh` 用 `--xxx`：

| PowerShell | bash | 作用 |
|---|---|---|
| `-Login` | `--login` | 装完立即 `magpie plugin login qiniu-ai` |
| `-Uninstall` | `--uninstall` | 卸载插件 |
| `-Force` | `--force` | 先 `plugin rm` 再重装 |
| `-DryRun` | `--dry-run` | 只打印将执行的命令，什么都不改 |
| `-Yes` / 兼容 `-y` | `--yes` / `-y` | 非交互（卸载不再确认） |
| `-NoColor` | `--no-color` | 关闭颜色（非 tty 时自动关） |
| `-Help` / `-h` | `--help` / `-h` | 帮助，退出码 `0` |

**只有这些。** 本仓库的安装器没有 `--doctor`、没有 `--mirror`、没有 `--ref`、不下载任何东西 —— 看到这类开关的说明都是过期的。

环境变量：

| 变量 | 作用 |
|---|---|
| `MAGPIE_BIN` | 指定 `magpie` 可执行文件路径（也用于测试里的假桩） |
| `BUN_BIN` | 验收脚本 `_tools/verify.mjs` 用；本机只有 bun 时指到 `bun.exe`（可选） |

插件运行时没有环境变量开关：`promptCache` 等行为全部走下面的 options。上表两个变量只影响安装脚本与验收脚本。

## 插件配置

写进 `plugins.json` 里这一项的 `options`，或用 `magpie plugin options magpie-qiniu-lite '<json>'` 设置（`off` 清除）。全部会夹紧：

| key | 类型 | 默认 | 夹紧 / 说明 |
|---|---|---|---|
| `providerId` | string | `qiniu-ai` | 只允许 `[a-z0-9-]`、≤40，否则回落默认 |
| `inferBase` | string | `https://api.qnaigc.com/v1` | 自动去尾斜杠 |
| `maxConcurrency` | number | `4` | 1..1000；用户在供应商上设的上限优先 |
| `usageCacheMs` | number | `30000` | 10000..600000，用量/余额面板的缓存窗口 |
| `liveModelList` | boolean | `true` | `provider.models` 拉 `/v1/models` 合并进模型表 |
| `modelListTtlMs` | number | `3600000` | 60000..86400000，在线模型表缓存 |
| `promptCache` | boolean | `false` | 注入 `prompt_cache_key`（上游文档没这个字段，默认不开） |
| `quotaFailover` | boolean | `true` | 402 / 欠费 403 改写成 429 + `retry-after`，让宿主切下一个账号 |
| `showCost` | boolean | `true` | 是否查 `cost` / `cost-detail` 窗口 |
| `costSampleMs` | number | `600000` | 60000..3600000，两次费用取样最小间隔 |
| `claudeBypass` | boolean | `false` | 把原厂 Claude 透传通路（`/bypass/anthropic`）纳入模型表 |
| `keyLabel` | string | `""` | ≤40，给自动签发的 Key 打备注 |
| `stateDir` | string | `""` | ≤300，状态目录（当前仅保留） |
| `pacingMinMs` | number | `800` | 0..60000，**出站节奏闸**：同账号相邻放行的最小间隔，`0` = 关掉间隔闸 |
| `pacingJitterMs` | number | `400` | 0..60000，每次放行叠加的随机抖动上限 |
| `breakerThreshold` | number | `5` | 0..100，**账号级熔断**：连续失败多少条开闸，`0` = 禁用 |
| `breakerCooldownMs` | number | `1800000` | 60000..28800000，首次熔断冷却，之后按 2^n 指数退避（封顶 8h） |
| `retryOnNetworkError` | boolean | `true` | 传输层错误（连接被重置等）重试一次 |

> 上表就是 `readOptions()` 实际收口的**全部**字段。早期文档里出现过的 `baseUrl` / `chatTimeoutMs` / `autoCreateKey` / `showAllModels` / `modelOverrides` / `extraHeaders` / `dailyUsageDays` 从未实现，填了也不生效。

## 出站两道闸（1.1.0）

七牛的限流是**按账号**的三个窗口：RPM / TPM（分钟）、TPD（日）。错误分档只能事后补救，所以出网前还有两道本地闸：

| 闸 | 文件 | 解决什么 | 关掉 |
|---|---|---|---|
| **节奏闸** | `src/pacing.mjs` | 并发把一个账号的分钟窗口打穿 —— 按账号把放行间隔拉开到 `pacingMinMs` 并叠 `pacingJitterMs` 抖动，请求分布先落回限额内 | `pacingMinMs: 0`（抖动保留）或两者都 0 |
| **熔断闸** | `src/breaker.mjs` | 撞上 TPD / 欠费后宿主还在原地重试 —— 连续失败到 `breakerThreshold` 就在本地直接回 `429 breaker_open` + `retry-after`，冷却到期放一个探测，成功关闭、失败退避翻倍 | `breakerThreshold: 0` |

两条都**按账号分桶**：A 号熔断或在等间隔时，B 号立刻能走。熔断状态只在内存里（进程重启即清空）—— 宁可少冷却一次，也不让一份过期状态文件把账号锁死。

只有**账号级**失败才喂熔断器：`401`（Key 失效）、`402`（余额不足）、`403`（欠费/停用/Key 额度）、`429`（限流）。模型级问题（`404` 未标价、模型不在订阅组）算账号健康 —— 换模型就能好，不该动账号。传输层网络错误只重试一次、不喂熔断器。

诊断：`magpie plugin diagnostics magpie-qiniu-lite` 里能看到 `pacing` / `breaker` 两块实时快照。


```bash
magpie plugin options magpie-qiniu-lite '{"showAllModels":false,"dailyUsageDays":14}'
```

## 测试

```bash
node --check plugin/index.mjs && node --check plugin/src/*.mjs   # 两端语法：node 侧
node plugin/tests/smoke.mjs                                      # 装配自检
node --test plugin/tests/*.test.mjs                              # 单测
node --test tests/e2e/installer.test.mjs                         # 安装脚本端到端
bash -n install.sh && bash install.sh --help && MAGPIE_BIN=/bin/true bash install.sh --dry-run
```

```powershell
# PowerShell 侧语法检查（不执行脚本）
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("$PWD\install.ps1",[ref]$null,[ref]$e); if($e){$e}else{'ok'}
.\install.ps1 -DryRun
```

本机只有 bun 时用 `bun test` 与 `bun run` 跑同一批文件（测试只用 `node:test` + `node:assert/strict`，在 Bun 里可用）。

**全部不联网。** 单测里七牛的 AK/SK 签名用自造的固定 AK/SK 与固定时间戳断言签名串，用量接口用注入的假 `fetchImpl`；端到端用 `tests/e2e/fake-magpie` 桩（`plugin add|list|rm|login`，状态落 `$FAKE_MAGPIE_STATE`）真跑一遍安装脚本，验证装 → 重装 → `--force` → 卸载，以及缺插件源码时退出码 `2`。测试**不会碰** `~/.config/magpie`。

## 排错

先看 [docs/troubleshooting.md](./docs/troubleshooting.md)（现象 → 定位 → 处理）和 [docs/faq.md](./docs/faq.md)。高频几条：

| 现象 | 处理 |
|---|---|
| `找不到插件源码` | 确认 `plugin/` 与脚本同级，别只在 `plugin/` 目录里跑脚本 |
| `没找到 magpie 命令` | 装 Magpie，或设 `MAGPIE_BIN` |
| 装完 `plugin list` 没有 `qiniu-ai` | 看 `plugin add` 的完整输出（magpie 把启动日志写在 stderr，脚本已 `2>$null`，正文才是结论），再 `-Force` 重试 |
| 报 `invalid ak/sk sign` | AK/SK 手抄错了，或用了 `sk-` 去签 AK/SK 接口 |
| `temporary key is not allowed` | 你填的是 `tk-` 临时 Key，换 `sk-` 正式 Key |
| 用量面板没百分比 | 上游没给分母，插件不编 —— 这是设计 |
| 改完代码 magpie 里没变化 | 命中宿主缓存，要 bump `plugin/package.json` 的 `version` |

## 开发

改插件前先读 [CONTRACT.md](./CONTRACT.md)（上游事实、钩子签名、模块归属）和 [plugin/README.md](./plugin/README.md)。

**七条硬规矩**（[CONTRACT.md](./CONTRACT.md) §0 的完整版）：

1. **不做每日签到**：不出现 `checkin` 钩子、不出现签到模块，测试要断言这一点。
2. **零运行时依赖**：只用 Node / Bun 内置（`node:crypto`、global fetch），`plugin/package.json` 里没有 `dependencies`。
3. **ESM `.mjs`**，`engines.node >= 22`（宿主是 magpie 内置 Bun 1.x）。
4. **不打印 secret**：一切 `sk-…` / `tk-…` / `AK:SK` / 签名必须过 `redact()`；`extraHeaders` 的值也一样。
5. **provider id = `qiniu-ai`**，不要改成 `qiniu`（理由见[上文](#provider-idqiniu-ai与社区插件的冲突说明)）。
6. **不碰 `~/.config/magpie`**（真配置）：一切验证用临时 HOME 或 `MAGPIE_BIN` 桩。
7. **改代码必须 bump `plugin/package.json` 的 `version`**，否则命中 Magpie 缓存，装了新的也看不到。

脚本侧的约束（两端等价、`set -uo pipefail` 不加 `-e`、`install.ps1` 禁用 `??` 与三元、UTF-8 **带 BOM**）见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 改完怎么装回本机

Magpie 注册的是**本地路径**，不是包名 —— 插件装的是你 clone 下来的那份 `plugin/`。所以改完代码：

```powershell
# Windows：先 rm 再 add，让 magpie 重新加载
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force
```

```bash
# macOS / Linux
./install.sh --force
```

装完确认：

```bash
magpie plugin list
# qiniu-ai (Qiniu AI Lite, 87 models)  signed in as <你的账号>
```

如果你机器上还装着 `github:tk103331/magpie-qiniu-plugin`，两份都在列表里是正常的（id 不同，互不接管）。想让本插件接管 `qiniu` 这个名字，见 [provider id 一节](#provider-idqiniu-ai与社区插件的冲突说明)。

### 一个坑：别删掉你 clone 的目录

插件注册的是 `...\magpie-qiniu\plugin` 这个路径，**删了克隆目录插件就没了**。想删仓库又保留插件，先把源码挪到稳定位置再重新注册：

```powershell
$stable = "$env:LOCALAPPDATA\magpie\plugins-src\magpie-qiniu-lite"
robocopy .\plugin $stable /MIR
magpie plugin add $stable
```

`%LOCALAPPDATA%\magpie\plugins-src\` 是 magpie 自己的插件源码目录，不会被工作区清理或磁盘整理波及。

## 许可

MIT，见 [LICENSE](./LICENSE)。Magpie：[usemagpie.ai](https://usemagpie.ai/) · [插件文档](https://usemagpie.ai/docs/plugins)

`plugin/src/catalog.mjs` 里的模型 id、倍率、`context` / `output` 是上游路由事实与保守估计，不是厂商承诺；上游数字（价格、额度、限流）随时会变，以[控制台](https://portal.qiniu.com/ai-inference/api-key)与[文档](https://developer.qiniu.com/aitokenapi)为准。
