# 安装器笔记（A5 · installer）

本文件记录 `install.ps1` / `install.sh` / `tests/e2e/*` 的实现取舍、**本机实测结果**、
以及只做了静态检查的部分。给 A6（`.gitattributes` / 验收）的建议在最后一节。

---

## 1. 落盘文件与字节形态

| 文件 | 换行 | BOM | 说明 |
| --- | --- | --- | --- |
| `install.ps1` | CRLF ×377 | **UTF-8 BOM** | PS 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，中文全乱；`#Requires -Version 5.1`，无 `??`、无三元 |
| `install.sh` | LF ×281 | 无 | `set -uo pipefail`（**故意不加 `-e`**） |
| `tests/e2e/fake-magpie.mjs` | LF | 无 | ESM，`node:fs` / `node:path` / `node:os` |
| `tests/e2e/fake-magpie` | LF | 无 | bash shim，**无扩展名 → 必须 LF，且 git 里要 100755** |
| `tests/e2e/fake-magpie.cmd` | CRLF ×17 | 无 | **纯 ASCII**（cmd.exe 按 OEM 代码页读批处理），末行 `exit /b %ERRORLEVEL%` |
| `tests/e2e/installer.test.mjs` | LF | 无 | `node:test` + `node:assert/strict` |

换行是用 `[IO.File]::WriteAllText` 逐文件重写后按字节统计确认的（CRLF/LF 互不混杂，
`.ps1`/`.cmd` 的 CRLF 计数 = 行数，`.sh`/`.mjs`/shim 的 LF 计数 = 行数）。

## 2. 本机实测（Windows 11 + Windows PowerShell 5.1.22621.4391 + Git Bash + bun 1.4.5）

本机 `pwsh`(PS7)、`node`、`bash` 都不在 PATH，实际用的是：

- PowerShell：`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1）
- bash：`C:\Program Files\Git\bin\bash.exe`（Git Bash，不在 PATH，显式绝对路径调用）
- 运行时：`C:\Users\...\Temp\bun-node-a7733435c\bun.exe`（同目录有 `node.exe`）

因为 `plugin/` 由主控写、本机此刻还没有，全流程在临时镜像目录
`%TEMP%\qiniu-e2e-run`（脚本 + `tests/` 原样拷入，另加 fixture `plugin/package.json`
name=`magpie-qiniu-lite` version=`0.1.0` + `plugin/index.mjs`）里真跑。

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `[void][Parser]::ParseFile("$PWD\install.ps1",…)` | 0 | `parse-ok`，无语法错 |
| 2 | `bash -n install.sh` | 0 | 语法通过 |
| 3 | `bash install.sh --help` | 0 | 18 行；与 `-Help` 逐行 `Compare-Object` **完全一致** |
| 4 | `MAGPIE_BIN=/bin/true bash install.sh --dry-run --no-color` | 0 | CONTRACT §7 的那一行，dry-run 不执行 magpie |
| 5 | `MAGPIE_BIN=<桩> bash install.sh --no-color`（真装） | 0 | 状态 `installed=1 / adds=1 / ops=["add"]`，stdout 含 `qiniu-ai` |
| 6 | `powershell -File install.ps1 -DryRun -NoColor` | 0 | 打印 `[dry] magpie plugin add …` |
| 7 | `powershell -File install.ps1 -NoColor`（真装） | 0 | 状态同上 |
| 8 | `powershell -File install.ps1 -Force -NoColor` | 0 | `ops=["add","rm","add"]` → 先 rm 后 add |
| 9 | `powershell -File install.ps1 -Uninstall -Yes -NoColor` | 0 | `installed=[]`，`removes=2` |
| 10 | `powershell -File install.ps1 -Bogus` | **1** | 我们自己的 `[x] 未知参数: -Bogus`，不是宿主绑定报错 |
| 11 | `bun test tests/e2e/installer.test.mjs` | **0** | **23 pass / 0 fail**（ps 12 例 + sh 11 例） |
| 12 | `bun run tests/e2e/installer.test.mjs` | 1 | Bun 1.4.5 报 `Cannot use test outside of the test runner`，**本机请用 `bun test`** |

## 3. 只做了静态检查 / 本机没跑成的（说明原因）

- **真 magpie 可执行文件**：本机没有，全部用 `tests/e2e/fake-magpie` 桩。`--version` 探活、
  `plugin list` 复核这两处对真 magpie 的行为只能按 CONTRACT 描述假设（启动日志写 stderr）。
- **`node --test`（CONTRACT §7 的命令）**：本机没有 node（`bun.exe` 旁边的 `node.exe` 是
  bun 的兼容副本，`node --test` 会被 bun 接管）。`bun test` 已验证；CI 上 `node --test` 走同一份
  文件、同一套 `node:test` API，`test.after` / `for` 循环里注册用例都按 node 语义写。
- **macOS 分支**（`/opt/homebrew/bin/magpie`、`/usr/local/bin/magpie` 等候选路径、`-t 1` 彩色）：
  只做代码审查，未在 macOS 实跑。
- **交互路径**（不带 `--yes` 的卸载确认、`--login` 的真人粘贴 Key）：只有 `--yes` / 桩路径实测。
- **CI ubuntu 端到端**：本机跑不了，命令见 CONTRACT §7。

## 4. 两端等价性

同一份 `usage` 文本（18 行，`--help` 与 `-Help` 输出逐行相同）、同一套退出码、同一套日志前缀：

| 语义 | install.ps1 | install.sh |
| --- | --- | --- |
| 登录 | `-Login`（也接受 `--login`） | `--login` |
| 卸载 | `-Uninstall` | `--uninstall` |
| 重装 | `-Force` | `--force` |
| 只看不做 | `-DryRun` | `--dry-run` |
| 非交互 | `-Yes` / `-y` | `--yes` / `-y` |
| 无色 | `-NoColor` | `--no-color`（非 tty 自动关） |
| 帮助 | `-Help` / `-h` / `--help` | `-h` / `--help` |

退出码：`0` 成功/取消/help；`1` 找不到 magpie 或未知参数；`2` 源码缺失/包名不符/
`plugin add` 失败；`3` 装后 `plugin list` 里没有 `qiniu-ai`。
日志前缀：`==> `（Step）/`[ok] `/`[!] `/`[x] `/三空格（Dim）。

`install.ps1` 用 `[Parameter(ValueFromRemainingArguments)]` 把 `--dry-run` 这类 POSIX 写法
归一成同名开关，所以两端**真能互相照抄参数**；落不到已知开关的 token 一律 `exit 1`（不再依赖
PowerShell 参数绑定失败的退出码，那个是宿主实现细节）。

## 5. 修掉的参考仓库（floatboat 版）缺陷

1. `install.ps1` 用 `Get-Help $PSCommandPath` 出帮助 → 与 sh 的 heredoc 文本不等价，且慢。
   改为两端手写同一份 18 行 usage（本轮实测逐行一致）。
2. `install.sh` 的 `--uninstall` 不管 `plugin rm` 成败都打印「已卸载」。改为按 `$?` 精确报告，
   两条规格都失败时只 `[!]` 提示「多半本来就没装」，仍 `exit 0`。
3. `sed` 抽 package.json 字段用 `.*"name"` 贪婪匹配 → 单行压缩 JSON 会取到**最后一个** `name`。
   改为「行首锚定优先 + 非锚定兜底」两段，且只取第一行命中。
4. `install.ps1` 复核用 `-match $Provider`（正则、大小写不敏感）。改为 `-clike` 配构造的
   wildcard（provider id 只含 `[a-z0-9-]`），sh 端用 `case` 子串，两端同为大小写敏感。
5. `install.ps1` 未知参数靠 PowerShell 绑定报错 → 退出码不可依赖。改为自己判定并 `exit 1`。
6. `ConvertFrom-Json` 无 try/catch：坏 JSON 先喷一屏红字再走到 `exit 2`。加 try/catch 明确报错。
7. 两端 `find_magpie` 只查固定路径，找不到时提示太弱。改为：`MAGPIE_BIN` → `command -v`/
   `Get-Command` → 逐 PATH 目录探 `magpie(.exe|.cmd|.bat|.sh|.bin)` → 常见安装位；
   找不到时打印 **PATH 里像 magpie 目录的候选**（文案举例 `D:\magpie`，但不写死该路径）+
   `MAGPIE_BIN` 用法。
8. e2e 桩与 shim 硬编码 `node`（本机没有）；`installer.test.mjs` 硬编码 `powershell.exe` 且
   无条件跑 `bash`。改为：shim 支持 `FAKE_MAGPIE_NODE` → `node` → `bun` 三级回退；
   测试探测 `pwsh`/`powershell.exe` 与 `bash`，探不到就 `t.skip()`（不 fail），
   且 `MAGPIE_BIN` 在 Git Bash 下自动转 POSIX 形式（桩侧再做 `toNative()` 转回盘符）。

## 6. 踩到的坑（留给后面的脚本作者）

- **PS 5.1 多行数组字面量 + 行尾 `+`**：`@( 'a', 'b ' + $x )` 里那行会被拆成**两个**元素
  （实测 count=3）。表现为帮助文本凭空多一行。要么加括号 `('b ' + $x)`，要么直接写字面量。
- **`$(...)` 会捕获 stdout**：`MAGPIE="$(find_magpie)"` 里若 `warn` 打到 stdout，提示文本会变成
  「magpie 路径」并让脚本 exit 0。这就是本机 e2e 第一轮唯一一条 fail，已改成 `>&2`。
  PowerShell 侧没有这个问题（`Write-Host` 走 information stream，不进赋值）。
- **`#Requires -Version 5.1` + BOM**：缺 BOM 时 PS 5.1 按 ANSI 解码，中文全是乱码。
- 大成功路径别忘 `2>$null` / `2>/dev/null`：桩故意每次往 stderr 写一行噪声，e2e 会断言
  stdout 里没有这行，所以「stderr 合并进 stdout」这类回归会被抓到。

## 7. e2e 的前置条件（A6/CI 注意）

1. 仓库里必须已有 `plugin/package.json`（`name` = `magpie-qiniu-lite`）与 `plugin/index.mjs`，
   否则 `install.*` 直接 `exit 2`——这是设计行为，测试里用临时目录伪造 fixture 覆盖该分支。
2. `tests/e2e/fake-magpie`（无扩展名 shim）需要可执行位。Windows 上 git 通常记不到 mode，
   请在 WSL/Linux/macOS 上执行一次：
   `git update-index --chmod=+x tests/e2e/fake-magpie`
3. 测试把 `dirname(process.execPath)` 前置进 `PATH`，这样 shim 里的 `node` 能解析到；
   完全没有 node 时 shim 会用 `bun`。
4. 本机跑：`bun test tests/e2e/installer.test.mjs`（**不要** `bun run …`，Bun 会在 runner 外报错）；
   CI 跑：`node --test tests/e2e/installer.test.mjs`。

## 8. 给 A6 的 `.gitattributes` 建议

```gitattributes
* text=auto
*.sh text eol=lf
*.ps1 text eol=crlf
*.cmd text eol=crlf
*.mjs text eol=lf
*.cjs text eol=lf
*.json text eol=lf
*.md text eol=lf
*.yml text eol=lf
*.html text eol=lf
tests/e2e/fake-magpie text eol=lf
*.png binary
*.zip binary
```

理由：

- `*.ps1` 必须 CRLF（Windows PowerShell ISE / 记事本友好，且避免 PS 5.1 在多行续行上的怪癖），
  `*.cmd` 必须 CRLF（cmd.exe 解析 LF-only 批处理时 `goto :label` 和 `%ERRORLEVEL%` 展开会出岔子）。
- `*.sh` 与无扩展名的 `tests/e2e/fake-magpie` 必须 LF，否则 Linux/macOS 上 `bash install.sh`
  会报 `\r: command not found` / `bad interpreter`。
- `*.mjs`、`*.json`、`*.md` 走 LF，`* text=auto` 兜底。
- **BOM 不在 `.gitattributes` 的管辖范围内**：`install.ps1` 的 UTF-8 BOM 靠提交内容保证。
  如果 CI 有「文件必须是 UTF-8 无 BOM」的检查，请把 `install.ps1` 排除掉。
- 若 CI 里跑 `bash -n` / `node --test`，建议顺手加一条
  `* text=auto` 之后的 `git ls-files --eol | grep -E 'ps1|cmd|sh'` 自查（非必须）。
