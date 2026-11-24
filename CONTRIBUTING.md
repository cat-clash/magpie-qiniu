# 贡献

本仓库是自包含的：安装脚本 + 插件本体（`plugin/`）。协议实现、AK/SK 签名、用量归一、错误分档都在这里，不依赖任何外部插件仓库。

动手前先读 [CONTRACT.md](./CONTRACT.md) —— 它是**唯一的契约真源**（上游实测事实、钩子签名、模块归属、options 夹紧范围）。文档与实现冲突时，以 CONTRACT 为准并顺手把文档改掉。

## 改脚本

- 两端必须**参数对齐**：`install.ps1` 与 `install.sh` 的开关一一对应（见 README「参数」）。只有 `--login/--uninstall/--force/--dry-run/--yes/--no-color/--help` 这七个，**别加** `--doctor`、`--mirror`、`--ref`。
- PowerShell 保持 5.1 可解析：文件用 UTF-8 **带 BOM** 保存，别用 PS7-only 语法（`??`、三元运算符）。
- bash 用 `set -uo pipefail`，**不要加 `-e`**（要靠显式判断给退出码）。抽 `package.json` 字段用 `sed`，不依赖 `jq` / `node`。
- `install.ps1` 调 magpie 时必须 `2>$null`：magpie.com 把启动日志写 stderr，不吞会被误判成失败。
- 两端日志前缀一致：`==> ` Step、`[ok] `、`[!] `、`[x] `、三空格 Dim；`-NoColor` 或非 tty 时置空颜色。
- 任何新增动作都要支持 `--dry-run`。
- 安装只允许三步：校验源码 → 定位 magpie → `plugin add`（然后 `plugin list` 复核）。别再加下载、重试、镜像、版本锁定。
- 退出码语义不许漂移：`0` 成功 / 取消 / `--help`；`1` 找不到 magpie 或未知参数；`2` 插件源码缺失 / 包名不符 / `plugin add` 失败；`3` 复核没有 `qiniu-ai`。
- e2e 依赖 `tests/e2e/fake-magpie`（`.mjs`/`.cmd` 桩，状态落 `$FAKE_MAGPIE_STATE`），桩的 `plugin list` 输出**必须含字面量 `qiniu-ai`**。

## 改插件

- 目录约定：一个模块一件事（`sign.mjs` 只管签名，`usage-api.mjs` 只管上游接口，`usage.mjs` 只管拼进度条）。
- **不打印 secret**：`sk-`、`tk-`、`AK:SK`、签名串、`extraHeaders` 的值一律过 `redact()`；日志里出现 `sk-xxxxxxxxxxxxxxxxxxxxxxxx` 这种形态才算合格。
- **不静默降级**：拿不到 Key 就抛 401 `sign_in_required`，不要拿空 Key 打网关。
- **模型不可用不能用 401**：`403` 里那些「这个模型没这个价 / 不在你的模型组」要改写成 **404** + `x-magpie-sign-in: kept`，否则会冤枉正常账号。
- **usage 不许编分母**：上游没给配额就不要写 `used`，也不要用 `0` 表示「不知道」；宁可只显示 `display` 文本。
- **不做签到、不做续期**：七牛没有这两种机制。别引入 `checkin.mjs` / `refresh.mjs`，也别用定时器模拟 —— 装配自检会断言 `auth.checkin` 不存在。
- **零运行时依赖**：`plugin/package.json` 里不许出现 `dependencies`。
- options 新增键必须同时做三件事：加进 `DEFAULTS`、加进 `CLAMP` 夹紧、写进 README 的配置表。
- 新增的开销优化要有计数器（照 `diagnostics` 快照的样子），否则无法验证。
- **改代码必须 bump `plugin/package.json` 的 `version`**，否则命中 Magpie 缓存。
- 别改 `providerId` 默认值 `qiniu-ai`（`qiniu` 被社区插件占用，共存说明见 README）。

## 提交前

```bash
node --check plugin/index.mjs && node --check plugin/src/*.mjs
node plugin/tests/smoke.mjs
node --test plugin/tests/*.test.mjs
node --test tests/e2e/installer.test.mjs
bash -n install.sh && bash install.sh --help && MAGPIE_BIN=/bin/true bash install.sh --dry-run
```

```powershell
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("$PWD\install.ps1",[ref]$null,[ref]$e); if($e){$e}else{'ok'}
.\install.ps1 -DryRun
```

只有 bun 的机器：`bun test` 与 `bun run` 跑同一批文件（测试只用 `node:test` + `node:assert/strict`）。

**测试必须不联网**，且不得读写 `~/.config/magpie`（用临时 HOME 或 `MAGPIE_BIN` 桩）。PR 里贴 `--dry-run` 输出与测试结果。

## 写文档

- 正文中文；英文只出现在宿主 UI 字段（`labels:{en}`、`importFroms`）。
- 不许写无法验证的话（"已通过安全审计"、"100% 兼容"）。有证据就指到 `research/` 里的实测记录或上游文档条目。
- 上游数字（价格、额度、限流、端点）变了，先更新 CONTRACT §1，再同步 README / docs。
- 示例里的凭据一律占位符，别贴真实 Key 形态的字符串。

## 版本

`plugin/package.json` 的 `version` 是插件版本；脚本行为变化不需要单独发插件版，但要在 PR 描述里写清影响面与最低 / 最高 magpie 版本。

## 许可

提交即表示同意以 MIT 发布。
