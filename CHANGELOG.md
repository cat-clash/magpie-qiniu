# CHANGELOG

本插件遵循语义化版本。`plugin/package.json` 的 `version` 决定 magpie 是否重新加载插件
（改完代码不 bump 会命中宿主缓存，GUI 里看不到变化）。

## 1.2.0 — 2026-11-27

### 修复

- **`/v3/stat/usage` 的查询参数写错，用量序列一直查不到数**：此前按上游文档发 `from`/`to`，
  但**上游只认 `start`/`end`** —— 实测返回
  `400 start parameter parse error, the format should be YYYY-MM-DDTHH:MM:SS±HH:MM`。
  后果是序列接口恒空：GUI 的「今日 tokens」永远显示「上游没返回今天的用量」，今日 TPD
  窗口也永远出不来。已改为 `start`/`end`，并加回归断言（`usage-api.test.mjs` 断言请求 URL
  里不许再出现 `from`/`to`）。

### 新增

- **诊断 CLI `node tools/doctor.mjs`**：一条命令回答「这个七牛账号现在到底还能不能用」。
  逐条给结论 + 修复建议，输出 `[ok]` / `[!]` / `[x]` 三档，问题项下面跟一行 `  →` 开头的建议；
  退出码 `0` 全通 / `1` 有问题 / `2` 用法错误。查七项：凭据是否存在 → Key 是否有效
  （`GET /v1/models`）→ 余额 / 待付 / 资源包（需 AK/SK）→ 今日 TPD 已用量 → 模型矩阵
  （需 `--probe-models`，会产生极小 chat 费用，默认关）→ options 自检（被夹紧 / 从未实现 /
  拼错的键）→ 熔断与节奏闸阈值现状。选项：`--json`、`--auth <path>`、`--provider <id>`、
  `--probe-models <n>`、`--models a,b,c`、`--help`。判定规则抽成纯函数（`src/doctor.mjs`），
  CLI 只负责读文件、发请求、打印。
- **「今日 TPD」窗口**：`auth.usage` 新增置顶窗口，文案是 `已用 X tokens（含缓存 Y）；上游不公布
  日上限，429 TPD 即到达。重置于下一个 +08 零点`。口径：上游 `/v3/stat/usage` 的单位是 kToken，
  插件 ×1000 换成 token；`days=1` 正好是「+08 日界 0 点 → 现在」，与上游 TPD 的日界一致。
  上游没给分母，所以只报已用量、不画百分比。
- **模型健康快照（`src/health.mjs`）**：进程内记每个模型的成功 / 失败，连续失败到
  `failureThreshold`（默认 3）标 dead，`provider.models` 钩子把 dead 模型的 `status` 改成
  `deprecated`，宿主不再路由它；`ttlMs`（默认 30 分钟）过期后重新给机会。只记「模型级」失败
  （改判 404 的未标价 / 不在订阅组 / 不存在），账号级 401/402/403/429 归熔断器 —— 一次成功
  即清零恢复。只在内存，进程重启即遗忘；阈值是模块默认值，暂未暴露成 options。
- **账号别名 / 优先级（`src/account-name.mjs`）**：从 auth 解析可读标签，优先级 `宿主别名 alias`
  → `metadata.alias` → `email` → `accountId` → `uid` → `API key …<脱敏>`；使用优先级
  `metadata.priority` → 别名里的 `p0`/`p1` 前缀（p0 最优先，解析时取负）→ 默认 0。
  `magpie accounts alias qiniu-ai <email> p0-main` 设的别名插件直接认，用量面板的账号名
  走同一链路解析，同邮箱多把 Key 靠宿主加的 `(hash)` 后缀区分。
- **provider 面板（`plugin/panel/`）**：magpie provider 槽位的设置面板，可视化调 `pacingMinMs` /
  `breakerThreshold` / `quotaFailover`，只在按「保存」时整份写回 options（不做逐键即时写入）。
- **契约漂移检测（`scripts/contract-diff.mjs`）**：一条命令比对三处 —— `plugin/src/config.mjs`
  的 `DEFAULTS` 键、README「插件配置」表、`CONTRACT.md` 反引号字段，报三类差集：**README 漏写**
  （用户看不到开关）、**代码没实现**（填了不生效）、**契约没提**。退出码 `0` 无差集 / `2` 有差集 /
  `1` 缺文件，支持 `--json`。

### 变更

- `diagnostics.snapshot()` 增 `modelHealth` 块（阈值 / ttl / dead 列表，便于现场判断
  「模型是被藏了还是上游真没了」）。
- 用量面板的账号名改由 `account-name.mjs` 统一解析（宿主 `magpie accounts alias` 设的别名
  第一次真正显示在插件侧）。

### 测试

- 新增 `doctor.test.mjs`（判定规则纯函数 + 报告渲染）、`health.test.mjs`（阈值 / 恢复 / ttl
  过期 / LRU 淘汰）、`account-name.test.mjs`（label 层级 / 优先级方向 / 排序稳定性）、
  `contract-diff.test.mjs`（三处键抽取 + 三类差集 + 退出码）、`panel-manifest.test.mjs`
  （面板清单离线可用）。
- `usage-api.test.mjs`：`fetchUsageSeries` 的精确 query 断言改为 `start`/`end`，并断言 URL
  里不再出现 `from`/`to` —— 这条是上面那个 bug 的回归闸。

## 1.1.0 — 2026-11-27

### 新增：出站两道本地闸（对齐 magpie-marvis 的工程化）

七牛的限流是**按账号**的三个窗口：RPM / TPM（分钟）与 TPD（日），且上游**不返回**
`retry-after`（`research/upstream-probe.md` 实测全站 0 个）。错误分档只能事后补救，
所以出网前补两道闸，都按账号分桶：

- **节奏闸** `src/pacing.mjs`：同步占位 + 异步等待，把同账号相邻放行间隔拉到
  `pacingMinMs`（默认 800ms）再叠 `pacingJitterMs`（默认 400ms）随机抖动。
  并发涌入同一账号时按调用顺序排队（0 / minGap / 2×minGap…），串行调用每次只等一个间隔。
- **熔断闸** `src/breaker.mjs`：连续账号级失败到 `breakerThreshold`（默认 5）→ open，
  本地直接回 `429 breaker_open` + `retry-after`，不打上游；冷却 `breakerCooldownMs`
  （默认 30 分钟）后 half-open 放行一个探测，成功关闭、失败重开且退避翻倍
  （30min → 1h → 2h → 4h → 8h 封顶，±10% jitter）。状态只在内存，不落盘。
- **传输层重试**：连接被重置 / DNS 抖动这类重发一次（请求没进上游，不涉及重复计费），
  `retryOnNetworkError: false` 可关；取消与超时不重试。

### 新增 options

`pacingMinMs` / `pacingJitterMs` / `breakerThreshold` / `breakerCooldownMs` /
`retryOnNetworkError`，夹紧范围见 README「插件配置」。

### 变更

- `diagnostics.snapshot()` 增 `pacing` / `breaker` 两块实时快照。
- 版本三处（`src/config.mjs`、`plugin/package.json`、根 `package.json`）统一到 1.1.0，
  `plugin-shape.test.mjs` 改为断言三者一致，以后 bump 不用再改测试。
- README「插件配置」表按 `readOptions()` 的真实字段重写；早期文档里的
  `baseUrl` / `chatTimeoutMs` / `autoCreateKey` / `showAllModels` / `modelOverrides` /
  `extraHeaders` / `dailyUsageDays` 从未实现，已明确标注。

### 测试

`pacing.test.mjs` 7 例 + `breaker.test.mjs` 10 例 + `relay-gates.test.mjs` 10 例；
全量 187 → **214 例**，Node 22 与 Node 24 双跑全绿。

## 1.0.1 — 2026-11-27（未单独发版，随 1.1.0 一起发布）

- 修：403 `Account is suspended due to billing status`（`code=account_billing_suspended`）
  未命中 arrears 规则，裸 403 直接透传，宿主把账号当「被拒」→ 改判 429 + `retry-after: 1200`。
- 新增：429 `TPD`/`RPM`/`TPM` 规则的 `retry-after` 由插件自己算
  （TPD → 下一个 +08 零点，夹 60..86400 秒；RPM/TPM → 60 秒），
  避免宿主用固定兜底把账号锁到天级。
- `NOT_AUTH_HINTS` 补 `billing` / `suspend` / `overdue` / `停用`，杜绝欠费被误标 `expired`。
- 修 CI：Node 22 的 test runner 会把「只等 unref 计时器」的用例判 `cancelledByParent`；
  Linux 上 pwsh 不能执行 `.cmd` 桩（4 个 `[ps]` e2e 用例因此 exit 2）。

## 1.0.0 — 2026-11-24

- 首个版本：`sk-` Key / AK/SK 两种登录、批量导入、用量与余额面板、`prompt_cache_key` 注入、
  Anthropic `/v1/messages` 透传、流式原样透传、错误分档、安装器（PowerShell / bash）与 CI。
