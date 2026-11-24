#Requires -Version 5.1
<#
.SYNOPSIS
    magpie-qiniu-installer —— 把本仓库内置的七牛云插件装进 Magpie（Windows）。

.DESCRIPTION
    四步：校验 plugin/ 源码 → 定位 magpie → magpie plugin add <本仓库 plugin 目录> → plugin list 复核。
    不联网、不下载、不依赖任何外部插件仓库：插件源码就在本仓库 plugin/ 里。
    兼容 Windows PowerShell 5.1：不用新式语法，也不做条件赋值。

.PARAMETER Login
    装完立即执行 magpie plugin login qiniu-ai。

.PARAMETER Uninstall
    卸载插件。

.PARAMETER Force
    已装也重装（先 plugin rm 再 plugin add）。

.PARAMETER DryRun
    只打印将执行的命令，不调用 magpie。

.PARAMETER Yes
    非交互（卸载时不再确认）。

.PARAMETER NoColor
    关闭彩色输出。

.PARAMETER Help
    显示帮助。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    .\install.ps1 -Login

.EXAMPLE
    .\install.ps1 -Force -DryRun

.EXAMPLE
    .\install.ps1 -Uninstall -Yes
#>
[CmdletBinding()]
param(
    [switch]$Login,
    [switch]$Uninstall,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$NoColor,
    [Alias('h')]
    [switch]$Help,
    # 让 --dry-run 这类 POSIX 写法与未知参数都落到这里，由我们自己判定：
    # 前者转成同名开关（两端等价），后者按契约 exit 1（不依赖宿主绑定报错）。
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

$Provider  = 'qiniu-ai'
$PkgName   = 'magpie-qiniu-lite'
$SiteUrl   = 'https://usemagpie.ai/'

# ---------------------------------------------------------------------------
# 输出（前缀两端一致：'==> ' / '[ok] ' / '[!] ' / '[x] ' / 三空格 Dim）
# ---------------------------------------------------------------------------
function Write-Clr {
    param([string]$Text, [string]$Color = 'Gray')
    if ($NoColor) { Write-Host $Text } else { Write-Host $Text -ForegroundColor $Color }
}
function Step  { param([string]$m) Write-Clr ("==> $m") Cyan }
function Ok    { param([string]$m) Write-Clr ("[ok] $m") Green }
function Warn2 { param([string]$m) Write-Clr ("[!] $m") Yellow }
function Err2  { param([string]$m) Write-Clr ("[x] $m") Red }
function Dim   { param([string]$m) Write-Clr ("   $m") DarkGray }

function Show-Usage {
    $lines = @(
        'magpie-qiniu-installer —— 把本仓库内置的七牛云插件装进 Magpie',
        '',
        '参数:',
        '  --login       装完执行 magpie plugin login qiniu-ai',
        '  --uninstall   卸载插件',
        '  --force       已装也重装（先 plugin rm 再 plugin add）',
        '  --dry-run     只打印将执行的命令，不调用 magpie',
        '  --yes / -y    非交互（卸载时不再确认）',
        '  --no-color    关闭彩色输出',
        '  -h / --help   显示帮助',
        '',
        'Windows 同名开关写作 -Login/-Uninstall/-Force/-DryRun/-Yes/-NoColor/-Help；',
        '--login 这类短横线写法在 install.ps1 里同样可用。',
        '',
        '环境变量: MAGPIE_BIN 指定 magpie 可执行文件路径',
        '退出码: 0 成功/取消/帮助  1 找不到 magpie 或未知参数',
        '        2 插件源码缺失、包名不符或 plugin add 失败',
        '        3 装完在 plugin list 里复核不到 qiniu-ai'
    )
    foreach ($l in $lines) { Write-Host $l }
}

# ---------------------------------------------------------------------------
# 参数归一（先于 --help：未知参数必须 exit 1，不能被打断成帮助）
# ---------------------------------------------------------------------------
if ($RemainingArgs) {
    foreach ($tok in $RemainingArgs) {
        if (-not $tok) { continue }
        if ($tok -like '--*') {
            $flat = $tok.Substring(2)
        } elseif ($tok -like '-*') {
            $flat = $tok.Substring(1)
        } else {
            Err2 "多余的位置参数: $tok（本脚本只接受开关）"
            Write-Host '用 -Help / --help 查看可用参数。'
            exit 1
        }
        $clean = ($flat -replace '[-_]', '').ToLower()
        if ($clean -eq 'login')      { $Login = $true }
        elseif ($clean -eq 'uninstall') { $Uninstall = $true }
        elseif ($clean -eq 'force')  { $Force = $true }
        elseif ($clean -eq 'dryrun') { $DryRun = $true }
        elseif ($clean -eq 'yes' -or $clean -eq 'y') { $Yes = $true }
        elseif ($clean -eq 'nocolor') { $NoColor = $true }
        elseif ($clean -eq 'help' -or $clean -eq 'h') { $Help = $true }
        else {
            Err2 "未知参数: $tok（用 -Help / --help 查看）"
            exit 1
        }
    }
}

if ($Help) { Show-Usage; exit 0 }

if ($DryRun) { Write-Clr '--- DRY RUN：只打印，不执行 ---' Yellow }

# ---------------------------------------------------------------------------
# 1. 校验插件源码（本仓库内置）
# ---------------------------------------------------------------------------
$pluginDir = Join-Path $PSScriptRoot 'plugin'
$pkgPath   = Join-Path $pluginDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Err2 "找不到插件源码：$pkgPath"
    Write-Host '请确认插件目录 plugin/ 与本脚本在同一仓库内（本仓库应是自包含的）。'
    exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'index.mjs'))) {
    Err2 "找不到插件入口：$pluginDir\index.mjs"
    Write-Host 'plugin/ 目录不完整，请重新拉取仓库。'
    exit 2
}

$pkg = $null
try {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Err2 "package.json 解析失败：$($_.Exception.Message)"
    exit 2
}
if (-not $pkg) {
    Err2 'package.json 内容为空或不是合法 JSON。'
    exit 2
}
if ($pkg.name -ne $PkgName) {
    Err2 "包名校验失败：$($pkg.name) != $PkgName"
    Write-Host '这个仓库只安装七牛云插件；包名不符说明 plugin/ 被换掉了。'
    exit 2
}
$pkgVer = '' + $pkg.version
if (-not $pkgVer) { $pkgVer = '0.0.0' }

# ---------------------------------------------------------------------------
# 2. 定位 magpie
# ---------------------------------------------------------------------------
function Get-MagpieEnvPathDirs {
    $dirs = @()
    if ($env:PATH) {
        foreach ($d in ($env:PATH -split ';')) {
            if ($d) { $dirs += $d }
        }
    }
    return $dirs
}

function Find-MagpieCli {
    if ($env:MAGPIE_BIN) {
        if (Test-Path -LiteralPath $env:MAGPIE_BIN) {
            return (Resolve-Path -LiteralPath $env:MAGPIE_BIN).Path
        }
        Warn2 "MAGPIE_BIN 指向的文件不存在：$env:MAGPIE_BIN（改用自动查找）"
    }
    $cmd = Get-Command magpie -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # PATH 里有目录但命令名对不上（magpie.exe 之外还有 magpie.cmd / 带后缀的发行版）时，逐目录探一遍。
    foreach ($d in (Get-MagpieEnvPathDirs)) {
        if (-not $d) { continue }
        if (-not (Test-Path -LiteralPath $d)) { continue }
        foreach ($leaf in @('magpie.exe', 'magpie.cmd', 'magpie.bat', 'magpie')) {
            $p = Join-Path $d $leaf
            if (Test-Path -LiteralPath $p) { return $p }
        }
    }

    $candidates = @()
    if ($env:ProgramFiles)        { $candidates += (Join-Path $env:ProgramFiles 'magpie\magpie.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'magpie\magpie.exe') }
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\magpie\magpie.exe')
        $candidates += (Join-Path $env:LOCALAPPDATA 'magpie\magpie.exe')
        $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\magpie.exe')
    }
    if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.magpie\bin\magpie.exe') }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Get-MagpiePathHints {
    # PATH 里看起来像 magpie 安装目录的东西，用于「找不到」时的可操作提示
    $hits = @()
    foreach ($d in (Get-MagpieEnvPathDirs)) {
        if (-not $d) { continue }
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $dirHit = $d -match '(?i)magpie'
        $childHit = $false
        if (-not $dirHit) {
            try {
                $kids = @(Get-ChildItem -LiteralPath $d -Filter 'magpie*' -ErrorAction SilentlyContinue)
                if ($kids.Count -gt 0) { $childHit = $true }
            } catch { $childHit = $false }
        }
        if ($dirHit -or $childHit) { $hits += $d }
    }
    return ($hits | Select-Object -Unique | Select-Object -First 3)
}

function Invoke-Magpie {
    param(
        [Parameter(Mandatory)][string[]]$CliArgs,
        # 登录要给用户看提示，不能吞 stderr；其余调用一律 2>$null ——
        # magpie.com 会把启动日志写到 stderr，合并进 stdout 会污染解析。
        [switch]$Interactive
    )
    if ($DryRun) {
        Dim ('[dry] magpie ' + ($CliArgs -join ' '))
        return @{ Output = ''; Code = 0 }
    }
    $raw = $null
    if ($Interactive) {
        $raw = (& $Magpie @CliArgs)
    } else {
        $raw = (& $Magpie @CliArgs 2>$null)
    }
    $code = $LASTEXITCODE
    $output = (@($raw) | ForEach-Object { "$_" }) -join [Environment]::NewLine
    return @{ Output = $output; Code = $code }
}

$Magpie = Find-MagpieCli
if (-not $Magpie) {
    Err2 '没找到 magpie 命令。'
    Write-Host '可选做法（任一条即可）：'
    Write-Host "  1) 安装 Magpie：$SiteUrl ，装完重开终端再跑本脚本。"
    Write-Host '  2) 知道具体路径就直接指过去：'
    Write-Host "       `$env:MAGPIE_BIN = 'C:\path\to\magpie.exe'   # 然后再运行 install.ps1"
    Write-Host '  3) magpie 已经在某个进了 PATH 的目录里（例如 D:\magpie），只是命令名没被认出来：'
    Write-Host '       进那个目录看实际文件名（magpie.exe / magpie.cmd / 带后缀的发行版），把 MAGPIE_BIN 指到它；'
    Write-Host '       或确认该目录仍在 PATH 中（$env:PATH -split ";"）。'
    $hints = @(Get-MagpiePathHints)
    if ($hints.Count -gt 0) {
        Write-Host '   当前 PATH 里像 magpie 目录的候选：'
        foreach ($h in $hints) { Write-Host "     - $h" }
    }
    exit 1
}
Step "magpie: $Magpie"
Ok "插件源码：$pluginDir（$($pkg.name)@$pkgVer）"

if (-not $DryRun) {
    # 定位之后先探一次版本：MAGPIE_BIN 指错东西时，在这里给出明确提示（不作为致命错误）
    $ver = Invoke-Magpie -CliArgs @('--version')
    if ($ver.Code -eq 0 -and $ver.Output) {
        Dim ('version: ' + ($ver.Output -split "`n")[0])
    } elseif ($ver.Code -ne 0) {
        Warn2 "magpie --version 返回 $($ver.Code)，继续尝试安装。"
    }
}

# ---------------------------------------------------------------------------
# 3. 卸载
# ---------------------------------------------------------------------------
if ($Uninstall) {
    if ($Login) { Warn2 '--uninstall 与 --login 同时给出：按卸载处理，跳过登录。' }
    Step "卸载 $Provider"
    if (-not $Yes -and -not $DryRun) {
        $ans = Read-Host "确认卸载 $Provider 插件？[y/N]"
        if ($ans -notmatch '^(y|yes)$') { Warn2 '已取消。'; exit 0 }
    }
    # 规格有两种可能：本地目录规格，或 provider id 规格。都试一遍。
    $r1 = Invoke-Magpie -CliArgs @('plugin', 'rm', $pluginDir)
    $r2 = Invoke-Magpie -CliArgs @('plugin', 'rm', $Provider)
    if ($DryRun) {
        Ok '（dry-run）只打印了将执行的 plugin rm。'
    } elseif ($r1.Code -eq 0 -or $r2.Code -eq 0) {
        Ok '已卸载。'
    } else {
        Warn2 "plugin rm 返回非 0（$($r1.Code)/$($r2.Code)）：多半是本来就没装，不视为失败。"
    }
    exit 0
}

# ---------------------------------------------------------------------------
# 4. 安装（本仓库源码目录，一条命令）
# ---------------------------------------------------------------------------
# -Force：先 plugin rm 再 add。plugin add 对同一目录规格是幂等的，
# 不先移除的话「重装」只是把注册覆盖一遍，旧状态不会清掉。
if ($Force) {
    Step "重装：先移除已注册的 $Provider"
    $rm = Invoke-Magpie -CliArgs @('plugin', 'rm', $pluginDir)
    if ($rm.Output) { Write-Host $rm.Output }
    if (-not $DryRun -and $rm.Code -ne 0) {
        Warn2 "plugin rm 返回 $($rm.Code)（未安装可忽略）"
    }
}

Step "安装 $pluginDir"
$add = Invoke-Magpie -CliArgs @('plugin', 'add', $pluginDir)
if ($add.Output) { Write-Host $add.Output }
if (-not $DryRun -and $add.Code -ne 0) {
    Err2 "plugin add 失败（exit $($add.Code)）"
    Write-Host '先手动跑一次确认原因：magpie plugin add "' + $pluginDir + '"'
    exit 2
}

# ---------------------------------------------------------------------------
# 5. 复核
# ---------------------------------------------------------------------------
if (-not $DryRun) {
    $list = Invoke-Magpie -CliArgs @('plugin', 'list')
    $hay = '' + $list.Output
    if ($hay -clike ('*' + $Provider + '*')) {
        Ok "安装完成，$Provider 已出现在插件列表。"
    } else {
        Err2 "装完仍未在 plugin list 看到 $Provider"
        if ($hay) { Write-Host $hay }
        exit 3
    }
}

# ---------------------------------------------------------------------------
# 6. 可选登录
# ---------------------------------------------------------------------------
if ($Login) {
    Step "登录 $Provider（按提示粘贴 sk- 开头的 API Key，或 AK:SK 让插件自动签发 Key）"
    $lg = Invoke-Magpie -CliArgs @('plugin', 'login', $Provider) -Interactive
    if ($DryRun) {
        Ok '（dry-run）只打印了将执行的 plugin login。'
    } elseif ($lg.Code -eq 0) {
        Ok '登录流程结束。'
    } else {
        Warn2 "登录未完成，可稍后手动执行：magpie plugin login $Provider"
    }
} else {
    Write-Host ''
    Write-Clr '下一步（登录）：' Cyan
    Write-Host "    magpie plugin login $Provider"
    Write-Host '  或重新运行本脚本并加 -Login。'
    Write-Host '  Key 在控制台拿：https://portal.qiniu.com/ai-inference/api-key'
}

Write-Host ''
Ok '完成。'
Write-Host '查看状态：magpie plugin list'
exit 0
