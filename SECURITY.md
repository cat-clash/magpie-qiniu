# 安全

## 本仓库的范围

两个安装脚本（`install.ps1`、`install.sh`）**加上**插件本体（`plugin/`）。整个仓库自包含：脚本不下载任何东西，插件代码就在 `plugin/` 里，装之前可以逐行读完。

**不联网的地方**：安装过程（校验包名、定位 magpie、`plugin add <本地目录>`、`plugin list` 复核）完全不发请求。测试与 e2e 也不联网（假 `fetchImpl` + 假 magpie 桩）。

**会联网的地方**：只有运行时，且只有两个主机：

| 主机 | 用途 |
|---|---|
| `api.qnaigc.com` | 推理转发（`/v1/chat/completions`、`/v1/models`）、用量（`/v3/stat/*`、`/v2/stat/export_log`）、Key 与限额（`/v1/apikeys`、`/v1/apikey/quota/*`） |
| `api.qiniu.com` | 账号级账单（`/billing-api/v1/account/balance-overview`、`/billing-api/v1/respack/list`），仅 AK/SK 模式 |

没有第三方统计、没有遥测、没有回传对话内容或机器信息。`baseUrl` 可改，改到哪就只打到哪。

## 脚本做什么

1. 校验 `plugin/package.json` 存在且包名是 `magpie-qiniu-lite`；
2. 定位 `magpie`（PATH → 常见安装目录 → `MAGPIE_BIN`）；
3. `magpie plugin add <仓库内 plugin 目录>`；
4. `magpie plugin list` 复核 `qiniu-ai`。

**不做**：下载 / 解压 / 执行任何远程代码；写入系统目录；改注册表启动项；常驻进程；修改 `~/.config/magpie` 以外的宿主配置；卸载时不删你的账号数据之外的任何东西。

## 凭据处理

- 一切 `sk-…`、`tk-…`、`AK:SK`、签名串在**所有**日志与错误文案里都会被 `plugin/src/http.mjs` 的 `redact()` 替换；`extraHeaders` 里用户自定义的值同样过 `redact()`。
- Key 只存在 magpie 的账号存储与本进程内存里，插件**不额外落盘**、不上报。用量诊断快照里只出现 Key 的摘要（`keyDigest`），不出现原文。
- AK/SK 登录时，插件可能调用 `POST /v1/apikeys` **自动签发一把 `sk-` Key**（可用 `autoCreateKey: false` 关掉）。签出来的 Key 通过 `client.auth.set` 写回账号存储一次；写回失败只在内存保留，不重试、不刷日志。

**关于 AK/SK**：那是**账号级**凭据 —— 能读余额、开新 Key、看全账号账单，权限远大于单把 `sk-`。除非你确实需要账号级余额 / 全 Key 用量，否则优先只填 `sk-`。用 AK/SK 时请去七牛控制台建一把**只授予所需权限**的子账号密钥，不要用主账号 AK/SK。任何情况下都不要把 Key 贴进公开 issue —— 本仓库的 issue 模板要求先脱敏。

## 报漏洞

请用 GitHub **Private vulnerability reporting**（仓库 Security 标签页），不要在公开 issue 贴利用细节或真实 Key。请说明影响版本、复现步骤、影响面（任意命令执行 / 任意文件写 / 凭据泄露 / 签名实现错误 / 脱敏遗漏）。

我们**不声称**本插件通过过任何第三方安全审计或形式化验证 —— 这类话在这里没有意义。可验证的东西是：`plugin/package.json` 没有 `dependencies`（供应链面为零），以及 `node --test plugin/tests/*.test.mjs` 覆盖的行为断言（含「不存在 `auth.checkin` 钩子」、「`max_tokens: 0` 不会被写成输出上限」、「错误分档不把模型不可用报成 401」）。跑一遍就是最好的审查。

## 供应链

本仓库不含任何外部依赖，也不从远程仓库安装插件（`plugin add` 指向的是本地目录）。要审查插件，直接看 `plugin/src/`。
