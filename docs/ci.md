# CI 与本机一键验收

## CI 做什么

`.github/workflows/ci.yml` 在每次 `push` 和 `pull_request` 触发；矩阵只跑 `ubuntu-latest`，Windows 侧由同一个 job 里的 `pwsh` 步骤做 `install.ps1` 语法校验覆盖，因此不再额外加 windows runner。

顺序对齐 [CONTRACT.md §7](../CONTRACT.md)：

| 步骤 | 命令 | 目的 |
| --- | --- | --- |
| 检出 | 步骤名 `checkout`，`actions/checkout@v4` | 把仓库放进 runner |
| 运行时 | `actions/setup-node@v4`，`node-version: 22` | 固定契约要求的 Node.js 22 |
| 语法 | `node --check plugin/index.mjs` + 逐个检查 `plugin/src/*.mjs` | glob 只作 `--check` 的首参，必须逐文件跑才覆盖全部源码 |
| 冒烟 | `node plugin/tests/smoke.mjs` | 插件形状、钩子、脱敏红线的最低要求 |
| 单测 | `node --test plugin/tests/*.test.mjs` | 全部单元测试，不联网 |
| 端到端 | `node --test tests/e2e/installer.test.mjs` | 用 fake-magpie 桩真跑安装脚本 |
| shell | `bash -n install.sh`、`bash install.sh --help`、`bash install.sh --dry-run` | 语法、帮助、干跑；dry-run 设 `MAGPIE_BIN=/bin/true`，不调用真宿主 |
| PowerShell | `shell: pwsh` + `Parser::ParseFile('./install.ps1', ...)` | 语法错误收集到 `$errs`，非空即失败 |

本工程零运行时依赖（`package.json` 无 `dependencies`），所以工作流里**没有** `npm install` / `npm ci`。所有测试都不联网、不写 `~/.config/magpie`；端到端的状态文件是 fake-magpie 的临时桩状态。

## 本机一键验收

本机没有全局 node/npm，只有 bun：

```text
C:\Users\c\AppData\Local\Temp\bun-node-a7733435c\bun.exe  （v1.4.5，可联网）
```

在仓库根目录执行：

```powershell
& 'C:\Users\c\AppData\Local\Temp\bun-node-a7733435c\bun.exe' '_tools/verify.mjs'
```

脚本自身不联网。它按 CONTRACT §7 顺序逐条跑，每条 60 秒超时，打印 `[ok]` / `[fail]` / `[skip]` 与耗时；失败时打印捕获输出的尾部 20 行和退出码，末尾汇总 `N passed / M failed / K SKIP`。

### bun 探测与覆盖

探测顺序固定：

1. 环境变量 `BUN_BIN`（必须是存在的可执行文件）；
2. 固定临时路径 `C:\Users\c\AppData\Local\Temp\bun-node-a7733435c\bun.exe`；
3. PATH 里的 `bun`。

三者都找不到时打印中文提示并以 1 退出。覆盖示例：

```powershell
$env:BUN_BIN = 'D:\path\to\bun.exe'
& $env:BUN_BIN '_tools/verify.mjs'
```

辅助探测（缺失时按下面的 SKIP 规则处理，不误判失败）：

- **node**：PATH → bun 同目录的 `node.exe` → 都没有就用 `bun --check` / `bun run` 等价执行语法检查与 smoke。本机探测到的 `node.exe` 是 v26.3.0，满足 `engines.node >= 22`。
- **bash**：PATH → `C:\Program Files\Git\bin\bash.exe` → `C:\Program Files\Git\usr\bin\bash.exe`。找不到时 3 条 bash 步骤打印 `[skip]`。
- **PowerShell**：`pwsh` → `powershell.exe` → `powershell`。本机只有 `powershell.exe`（Windows PowerShell 5.1），同样支持 `Parser::ParseFile`；三者都没有时解析步骤打印 `[skip]`。

可选覆盖：`NODE_BIN` 指定 node 可执行文件，`BASH_BIN` 指定 bash 可执行文件。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 所有执行项通过；`[skip]` 不计入失败 |
| `1` | 找不到 bun 导致探测失败，或汇总中 `failed > 0` |

约定：因本机环境（缺 bash / 缺 PowerShell）不可跑的步骤标 `[skip]`，不是 fail；因代码或断言错误产生的非 0 退出标 `[fail]`，并计入汇总。

## 为什么没有每日签到

[CONTRACT.md §0](../CONTRACT.md) 的硬约束写死了：「不做每日签到：不出现 `checkin` 钩子、不出现签到模块。测试要断言这一点。」`plugin/tests/smoke.mjs` 明确断言 `auth.checkin === undefined`。因此 CI 只有 `push` / `pull_request` 两个触发器，没有 `schedule`，也没有任何签到任务；验收链路上只做语法检查、单测、端到端和安装脚本校验。
