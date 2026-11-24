# 常见问题

先查[排错页](./troubleshooting.md)（现象 → 定位 → 处理）；上游事实与 options 见 [CONTRACT.md](../CONTRACT.md)。

## 安装与生效

### Q1. 装完在 magpie 里看不到这个 provider，怎么办？

按顺序排：

1. `magpie plugin list` —— `qiniu-ai` 在不在列？不在说明 `plugin add` 就没成（看安装脚本的退出码，`2` 是源码 / 包名问题，`3` 是复核失败）。
2. 在列但供应商页没有 —— 说明插件加载失败了。`magpie plugin` 列表里会写明失败原因（一般是宿主跑不起来这段代码：Node/Bun 版本低于 22）。
3. 有两个插件都注册过 —— 同名 id 只有一个提供服务，另一个会标注由谁提供；用 `magpie plugin use <名字> <id>` 改选。

本插件的 id 是 **`qiniu-ai`**，不是 `qiniu`（见 [README](../README.md#provider-idqiniu-ai与社区插件的冲突说明)）。在列表里找 `qiniu-ai`。

### Q2. 改了插件代码，magpie 里还是旧行为？

**要 bump `plugin/package.json` 的 `version`。** magpie 按版本判断是否需要重新加载插件源码，版本号不动就会命中缓存，改得再多也看不见。

完整重装有两种：

```bash
magpie plugin rm <旧的 spec 或路径>
magpie plugin add ./plugin
```

或直接跑安装脚本的强制模式：`.\install.ps1 -Force` / `./install.sh --force`。

注意：仅改 options、开/关插件会触发宿主重载；**只改源码不会**，必须主动触发（bump 版本或重装）。

### Q3. 安装脚本有没有 `--doctor` / `--mirror` / 指定版本？

没有。安装器只有七个参数（`--login`、`--uninstall`、`--force`、`--dry-run`、`--yes`、`--no-color`、`--help`），全程不联网、不下载、不做版本锁定 —— 插件源码就在你手边的 `plugin/` 目录里。想看它会做什么就加 `--dry-run`。

### Q4. 装完之后能删掉 clone 的目录吗？

**不能直接删。** magpie 注册的是本地路径（`...\magpie-qiniu\plugin`），删了就等于把插件源码删了。要保留又不占工作区，先把 `plugin/` 复制到 magpie 自己的插件源码目录（Windows 建议 `%LOCALAPPDATA%\magpie\plugins-src\magpie-qiniu-lite`）再重新 `plugin add`。详见 [README「改完怎么装回本机」](../README.md#改完怎么装回本机)。

## 登录与凭据

### Q5. `tk-` 开头的临时 Key 能用吗？

**分场景。** 推理接口（`/v1/chat/completions`）可以；**用量与费用接口不行** —— `/v3/stat/*` 只认正式 `sk-` Key 或 AK/SK 签名，用 `tk-` 会拿到 `401 temporary key is not allowed`。

插件的表现就是：对话正常，用量面板给一句明确提示（不是空白面板）。想两样都有，去[控制台](https://portal.qiniu.com/ai-inference/api-key)创建正式 API 密钥，或用 AK/SK 登录让插件自动签发。

### Q6. AK/SK 和 `sk-`，我该选哪个？

| 你想要 | 选 |
|---|---|
| 只是让 magpie 能对话 | `sk-`（权限最小，够用） |
| 想看**账号级**余额、资源包、全部 Key 的费用 | AK/SK |
| 想让插件自己开一把推理 Key | AK/SK（`autoCreateKey`，默认开） |

AK/SK 是**账号级**凭据，能建 Key、读账单，权限远大于单把 `sk-`。要用就去控制台建只授予所需权限的子账号密钥，别用主账号 AK/SK。日常纯对话场景请选 `sk-`。

### Q7. 卸载会删掉我的 Key 吗？

安装脚本只调 `magpie plugin rm`，不碰 magpie 的账号存储。Key 留在宿主那里，重装就还在。要彻底清掉，去 magpie 的账号管理里删账号，或者直接到七牛控制台把那把 Key 停用（这才是真正的撤销）。

### Q8. 会不会把我的对话传到别的地方？

只会传给你配置的上游（默认 `api.qnaigc.com`，账单相关走 `api.qiniu.com`）。没有第三方统计、没有遥测，也没有任何"上报机器信息"的请求。日志里出现 Key / AK / SK / 签名的地方全部过 `redact()`。见 [SECURITY.md](../SECURITY.md)。

## 模型与额度

### Q9. 为什么插件里的模型比[模型广场](https://www.qiniu.com/ai/models)少？

三个原因，都在设计里：

1. **广场不是 API**。广场还包含图像生成、视频生成、语音等非 chat 端点的条目，`/v1/models` 不返回它们，本插件也不接。
2. **`service_status` 不是 `available` 的一律隐藏**。我们只实测确认了 `available` 这一个取值，其余含义未确认 —— 与其把可能已经不能用的模型塞进列表让宿主去撞错误，不如标成 `deprecated` 不显示（magpie 不显示 deprecated 模型）。
3. **未登录时用静态目录**。静态表只收录已核对过的条目，保证没网、没 Key 的时候供应商页也不是空的。

想看更全的：登录状态下 `showAllModels`（默认就是 `true`）会拉 `/v1/models` 合并；如果你怀疑某个模型被漏了，开个 issue 说明 id。

### Q10. 界面上的「免费」标记是从哪来的？

**不是从 `/v1/models` 来的** —— 上游那个接口不返回免费字段。它来自插件内置的兜底表 `FREE_IDS`（`plugin/src/catalog.mjs`），按模型广场公示的限时免费名单维护。

宿主的规则是：只有模型上的 `free: true` 会让它算作免费，**magpie 不会从 `rate` 推断**（`rate: 0` 视为"没给倍率"，不是免费）。所以这个标记有滞后风险：上游改价、活动结束时这里可能还没跟上。真正的价格以控制台与[定价页](https://www.qiniu.com/ai/models)为准。

### Q11. 新用户送多少？要去哪领？

注册成为七牛云开发者即有免费 Token 额度；**首次创建 API 密钥会激活 300 万 Token 的免费额度资源包**（控制台原文口径）。这是一次性发放的资源包，不需要插件做任何事。

有效期与适用范围是上游活动规则，可能调整 —— 看[控制台](https://portal.qiniu.com/ai-inference/api-key)与[计费说明](https://developer.qiniu.com/aitokenapi)。

### Q12. 所以真的没有每日签到吗？能不能加一个？

**没有，也不会加。** 七牛是按量付费的 API Key 模式：余额、资源包、Key 限额，全是"花一分扣一分"，不存在"每天点一下送额度"这类机制，上游没有可调的签到接口。

magpie 确实提供了 `auth.checkin` 钩子，但那是给"每日签到送额度"的供应商用的（OpenCode 会忽略它）。在没有这个机制的上游实现它，只能靠伪造请求或定时打无关接口，那是错的。所以本插件不出现 `checkin` 钩子、不出现签到模块，并且单测里有一条断言专门守着这件事。详见 [README](../README.md#本插件没有每日签到)。

## 用量与费用

### Q13. 为什么不显示百分比 / 进度条，只有一行文字？

因为**上游没给分母**，而插件不编数字。

宿主契约写得很直白：厂商没有给出 `used` 时就不要传，**不要用 0 表示"不知道"**。没有 `used` 但给了 `amount` 和 `limit` 时窗口才按数量算；两者都没有时，窗口只显示 `display` 文本，且路由不会把它当成额度参考。

具体到这里：Key 限额（月度可消费金额）是有分母的 → 会显示百分比；账号余额与资源包是预付钱包 → 按 `balance` 显示剩余额度，**不显示百分比**；`/v3/stat/usage` 的 token 消耗只是累计量，没有配额 → 只显示文本。这是设计，不是坏掉了。

### Q14. 面板里的数字为什么比实际落后？多久能更新？

两层滞后：

- **上游**：预估账单与资源包剩余额度官方口径就是**延迟 15 分钟左右**；用量序列的当天数据可能不全，官方建议以昨天及之前的数据为准。
- **插件**：`usageCacheMs` 默认 **30 秒**（下限 5 秒），同一时间窗内重复打开面板不会重复打上游。

所以刷新面板看到 5～15 分钟量级的滞后是正常的。要更激进就把 `usageCacheMs` 调到 5000，但注意下一条。

### Q15. 用量接口有速率限制吗？会不会因为面板被限流？

有：`/v3/stat/usage` 同 IP **5 req/s**。插件因此做了三层收敛 —— 30 秒缓存、`dailyUsageDays`（默认 7 天，夹紧 1..31）限制回溯跨度、`granularity=day` 跨度 ≤31 天 / `hour` ≤7 天。多账号共用一个出口 IP 时尤其别把缓存调到最低。

触发限流的表现与处理写在[排错页](./troubleshooting.md)。

### Q16. 费用数字和财务中心账单对不上？

正常。`/v3/stat/usage/apikey/cost*` 返回的是**原始标准价格**，**不含资源包抵扣、折扣、代金券**；预估账单页本身也是"只展示基于使用量和模型价格计算的预估计费数据"。实际结算以财务中心为准。

另外余额数字的单位是 **元 × 1e8**，插件会除回去再显示 —— 如果你直接看接口原文，别忘这一层。

### Q17. 402 之后多久能恢复？

`402` 是**余额或资源包不足**，它不是临时限流，不会自己过期恢复。恢复条件是你把额度补上：

1. 充值或购买资源包（[控制台](https://portal.qiniu.com/ai-inference/api-key) / 计费中心）；
2. 上游入账后，扣费判定随之恢复 —— 但**面板上的数字最长还要再滞后约 15 分钟**才变得好看；
3. 插件这侧最多再等 `usageCacheMs`（默认 30 秒）才会重新读上游。

也就是说：充值完立刻再发请求通常就能过；如果面板还显示"余额不足"，等 30 秒到 15 分钟，别怀疑没生效。

### Q18. 我设了 Key 限额，为什么这条请求还是跑完了？

上游行为：**达到限额后停止的是新请求**，已经在处理中的会继续完成，所以实际生效额度与配置额度会有略微差异。另外限额配置写入后可能有 **0～30 秒**延迟才生效。

想硬性掐住，就单独开一把 Key 给它设限额，而不是设账号级余额提醒。

## 行为与边界

### Q19. 注入 `prompt_cache_key` 能省钱吗？

**别指望。** 它只是给上游一个稳定的会话路由键，让同一段对话更容易落到同一个缓存亲和点，属于命中率优化，不保证结果，也不改变计费。

七牛的**显式**上下文缓存是 Anthropic 风格的 `cache_control`（`type: "ephemeral"`，默认 5 分钟有效；**写入按标准价 125%、命中按 10%**，5 分钟内命中 2 次以上才整体划算），且只有 Claude 系模型真正生效 —— 其他模型带 `cache_control` 不报错也不生效。本插件**不代你写** `cache_control`，也不声称帮你省了钱。

### Q20. 支持 Anthropic 那套 `/v1/messages` 吗？

上游文档把它列为兼容接口（`endpoints.md` 与 `anthropic-chat.md`，示例鉴权用 `x-api-key` 而不是 `Authorization: Bearer`）。插件按契约把 `POST **/v1/messages` 走同一条转发，**只做原样透传，不做协议改写**。

诚实的前提是：截至本页更新时，`research/` 里**还没有这个端点的本机实测记录**。所以别把它当 Claude Code 的替代品下单 —— 推理能力取决于你选的模型；如果实测发现不通，README 与本页都会把它改成「不支持」。

### Q21. 能不能换到海外端点？

可以，用 option `baseUrl`（必须 https，尾斜杠会被去掉）。上游另有海外接入点 `https://api.modelink.ai`。

注意 `baseUrl` 只影响**推理**；用量与账单接口（`api.qnaigc.com/v3`、`api.qiniu.com/billing-api`）的地址不由它决定。换端点不会让用量面板跟着搬家。

### Q22. 和 `github:tk103331/magpie-qiniu-plugin` 冲突吗？

不冲突，**可以共存**：本插件用 `qiniu-ai`，那个插件用 `qiniu`，宿主把它们当两个供应商，账号与模型目录互不干扰。

想沿用 `qiniu` 这个名字，得先卸掉占用者，再把本插件挂上去（`magpie plugin use magpie-qiniu-lite qiniu`，需要宿主支持改挂 id）。或者干脆改本插件的 `providerId` option（只允许 `[a-z0-9-]`）。

### Q23. 这插件有运行时依赖吗？我需要装 npm 包吗？

没有。`plugin/package.json` 里没有 `dependencies`，只用 Node / Bun 内置能力（`node:crypto`、global fetch）。要求只有：magpie（宿主内置 Bun 1.x）+ 本机 Node `>= 22`（跑测试 / 装脚本时用）。

### Q24. 想提 issue / 提功能建议

用仓库的 [issue 模板](../.github/ISSUE_TEMPLATE/)。bug 报告需要五样：环境、出问题的一步、用的参数、**已脱敏**的日志（`-DryRun` 输出比截图有用）、两个自检勾。别贴真实 Key。
