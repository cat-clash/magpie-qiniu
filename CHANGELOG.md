# CHANGELOG

本插件遵循语义化版本。`plugin/package.json` 的 `version` 决定 magpie 是否重新加载插件
（改完代码不 bump 会命中宿主缓存，GUI 里看不到变化）。

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
