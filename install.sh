#!/usr/bin/env bash
# magpie-qiniu —— 把本仓库内置的七牛云插件装进 Magpie（macOS / Linux）
#
#   四步：校验 plugin/ 源码 → 定位 magpie → magpie plugin add <仓库内 plugin/> → plugin list 复核。
#   不联网、不下载、不依赖任何外部插件仓库，也不依赖 jq / node / curl。
#
#   ./install.sh                 安装
#   ./install.sh --login         装完即登录
#   ./install.sh --force         重装（先 rm 再 add）
#   ./install.sh --uninstall     卸载
#   ./install.sh --dry-run       只打印命令
#
# 与 install.ps1 两端等价：同一套开关、同一套退出码、同一套日志前缀。
set -uo pipefail

PROVIDER="qiniu-ai"
PKG_NAME="magpie-qiniu-lite"
SITE_URL="https://usemagpie.ai/"

LOGIN=0; UNINSTALL=0; FORCE=0; DRY=0; YES=0; NOCOLOR=0

usage() {
  cat <<EOF
magpie-qiniu —— 把本仓库内置的七牛云插件装进 Magpie

参数:
  --login       装完执行 magpie plugin login $PROVIDER
  --uninstall   卸载插件
  --force       已装也重装（先 plugin rm 再 plugin add）
  --dry-run     只打印将执行的命令，不调用 magpie
  --yes / -y    非交互（卸载时不再确认）
  --no-color    关闭彩色输出
  -h / --help   显示帮助

Windows 同名开关写作 -Login/-Uninstall/-Force/-DryRun/-Yes/-NoColor/-Help；
--login 这类短横线写法在 install.ps1 里同样可用。

环境变量: MAGPIE_BIN 指定 magpie 可执行文件路径
退出码: 0 成功/取消/帮助  1 找不到 magpie 或未知参数
        2 插件源码缺失、包名不符或 plugin add 失败
        3 装完在 plugin list 里复核不到 $PROVIDER
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --login) LOGIN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    --yes|-y|yes) YES=1 ;;
    --no-color) NOCOLOR=1 ;;
    -h|--help) usage; exit 0 ;;
    # 与 install.ps1 一致：提示走 stdout，退出码 1
    -*) printf '[x] 未知参数: %s（用 --help 查看）\n' "$1"; exit 1 ;;
    *) printf '[x] 多余的位置参数: %s（本脚本只接受开关）\n' "$1"
       printf '    用 -Help / --help 查看可用参数。\n'; exit 1 ;;
  esac
  shift
done

if [ "$NOCOLOR" = "1" ] || [ ! -t 1 ]; then
  C_STEP=""; C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
else
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[90m'; C_RST=$'\033[0m'
fi

step(){ printf '%s==> %s%s\n' "$C_STEP" "$*" "$C_RST"; }
ok(){   printf '%s[ok] %s%s\n' "$C_OK" "$*" "$C_RST"; }
warn(){ printf '%s[!] %s%s\n' "$C_WARN" "$*" "$C_RST"; }
err(){  printf '%s[x] %s%s\n' "$C_ERR" "$*" "$C_RST"; }
dim(){  printf '%s   %s%s\n' "$C_DIM" "$*" "$C_RST"; }

[ "$DRY" = "1" ] && warn 'DRY RUN：只打印，不执行'

# 只取 stdout：magpie.com 会把启动日志写到 stderr，合并会污染输出
run_magpie() {
  if [ "$DRY" = "1" ]; then dim "[dry] magpie $*"; return 0; fi
  "$MAGPIE" "$@" 2>/dev/null
}

# 登录要给人看提示，stderr 不丢
run_magpie_interactive() {
  if [ "$DRY" = "1" ]; then dim "[dry] magpie $*"; return 0; fi
  "$MAGPIE" "$@"
}

find_magpie() {
  local d leaf c oldifs
  if [ -n "${MAGPIE_BIN:-}" ]; then
    if [ -x "$MAGPIE_BIN" ]; then echo "$MAGPIE_BIN"; return; fi
    # 这个函数的结果会被 $(...) 捕获，诊断信息必须走 stderr，否则会当成路径
    warn "MAGPIE_BIN 指向的文件不可执行：$MAGPIE_BIN（改用自动查找）" >&2
  fi
  if command -v magpie >/dev/null 2>&1; then command -v magpie; return; fi
  # PATH 里有目录但命令名对不上时，逐目录探一遍常见名字
  oldifs="$IFS"; IFS=':'
  for d in $PATH; do
    [ -n "$d" ] || continue
    [ -d "$d" ] || continue
    for leaf in magpie magpie.sh magpie.bin; do
      if [ -x "$d/$leaf" ]; then echo "$d/$leaf"; IFS="$oldifs"; return; fi
    done
  done
  IFS="$oldifs"
  for c in /usr/local/bin/magpie /opt/homebrew/bin/magpie /usr/bin/magpie \
           "$HOME/.local/bin/magpie" "$HOME/.magpie/bin/magpie" /snap/bin/magpie; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
}

# PATH 里看起来像 magpie 安装目录的东西，用于「找不到」时的可操作提示
path_hints() {
  local d f oldifs
  oldifs="$IFS"; IFS=':'
  for d in $PATH; do
    [ -n "$d" ] || continue
    [ -d "$d" ] || continue
    case "$d" in
      *magpie*|*Magpie*|*MAGPIE*) printf '%s\n' "$d"; continue ;;
    esac
    for f in "$d"/magpie*; do
      [ -e "$f" ] && { printf '%s\n' "$d"; break; }
    done
  done
  IFS="$oldifs"
}

report_no_magpie() {
  err '没找到 magpie 命令。'
  echo '可选做法（任一条即可）：'
  echo "  1) 安装 Magpie：$SITE_URL ，装完重开终端再跑本脚本。"
  echo '  2) 知道具体路径就直接指过去：'
  echo "       MAGPIE_BIN=/path/to/magpie ./install.sh"
  echo '  3) magpie 已经在某个进了 PATH 的目录里（例如 /opt/magpie/bin，Windows 上类似 D:\magpie），'
  echo '       只是命令名没被认出来：进那个目录看实际文件名，把 MAGPIE_BIN 指到它；'
  echo '       或确认该目录仍在 PATH 中（echo "$PATH" | tr : "\n"）。'
  hints="$(path_hints | sort -u | head -n 3)"
  if [ -n "$hints" ]; then
    echo '   当前 PATH 里像 magpie 目录的候选：'
    printf '%s\n' "$hints" | while IFS= read -r h; do [ -n "$h" ] && printf '     - %s\n' "$h"; done
  fi
}

# ---------------------------------------------------------------- 1. 插件源码
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"
PKG_JSON="$PLUGIN_DIR/package.json"

if [ ! -f "$PKG_JSON" ]; then
  err "找不到插件源码：$PKG_JSON"
  echo '请确认 plugin/ 目录与本脚本在同一仓库内（本仓库应是自包含的）。'
  exit 2
fi
if [ ! -f "$PLUGIN_DIR/index.mjs" ]; then
  err "找不到插件入口：$PLUGIN_DIR/index.mjs"
  echo 'plugin/ 目录不完整，请重新拉取仓库。'
  exit 2
fi

# 只用 sed：先试「行首锚定」的漂亮 JSON，再退回不限位置的写法（单行压缩 JSON）
pkg_field() {
  local key="$1" file="$2" v=''
  v="$(sed -n "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1)"
  if [ -z "$v" ]; then
    v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1)"
  fi
  printf '%s' "$v"
}

pkg_name="$(pkg_field name "$PKG_JSON")"
pkg_ver="$(pkg_field version "$PKG_JSON")"
[ -n "$pkg_ver" ] || pkg_ver="0.0.0"
if [ "$pkg_name" != "$PKG_NAME" ]; then
  err "包名校验失败：${pkg_name:-?} != $PKG_NAME"
  echo '这个仓库只安装七牛云插件；包名不符说明 plugin/ 被换掉了。'
  exit 2
fi

# ---------------------------------------------------------------- 2. magpie
MAGPIE="$(find_magpie)"
if [ -z "$MAGPIE" ]; then
  report_no_magpie
  exit 1
fi
step "magpie: $MAGPIE"
ok "插件源码：$PLUGIN_DIR（$pkg_name@$pkg_ver）"

if [ "$DRY" != "1" ]; then
  # 定位之后先探一次版本：MAGPIE_BIN 指错东西时在这里给出提示（不作为致命错误）
  ver_out="$(run_magpie --version)"
  ver_code=$?
  if [ "$ver_code" -eq 0 ] && [ -n "$ver_out" ]; then
    dim "version: $(printf '%s\n' "$ver_out" | head -n 1)"
  elif [ "$ver_code" -ne 0 ]; then
    warn "magpie --version 返回 $ver_code，继续尝试安装。"
  fi
fi

# ---------------------------------------------------------------- 3. 卸载
if [ "$UNINSTALL" = "1" ]; then
  [ "$LOGIN" = "1" ] && warn '--uninstall 与 --login 同时给出：按卸载处理，跳过登录。'
  step "卸载 $PROVIDER"
  if [ "$YES" != "1" ] && [ "$DRY" != "1" ]; then
    ans=''
    printf '确认卸载 %s 插件？[y/N] ' "$PROVIDER"; read -r ans
    case "$ans" in y|Y|yes|YES) ;; *) warn '已取消。'; exit 0 ;; esac
  fi
  run_magpie plugin rm "$PLUGIN_DIR"; rc1=$?
  run_magpie plugin rm "$PROVIDER";   rc2=$?
  if [ "$DRY" = "1" ]; then
    ok '（dry-run）只打印了将执行的 plugin rm。'
  elif [ "$rc1" -eq 0 ] || [ "$rc2" -eq 0 ]; then
    ok '已卸载。'
  else
    warn "plugin rm 返回非 0（$rc1/$rc2）：多半是本来就没装，不视为失败。"
  fi
  exit 0
fi

# ---------------------------------------------------------------- 4. 安装
# --force：先 plugin rm 再 add。plugin add 对同一目录规格是幂等的，
# 不先移除的话「重装」只是把注册覆盖一遍，旧状态不会清掉。
if [ "$FORCE" = "1" ]; then
  step "重装：先移除已注册的 $PROVIDER"
  if [ "$DRY" = "1" ]; then
    dim "[dry] magpie plugin rm $PLUGIN_DIR"
  else
    out="$(run_magpie plugin rm "$PLUGIN_DIR")"; rc=$?
    [ -n "$out" ] && printf '%s\n' "$out"
    if [ "$rc" -ne 0 ]; then warn "plugin rm 返回 $rc（未安装可忽略）"; fi
  fi
fi

step "安装 $PLUGIN_DIR"
if [ "$DRY" = "1" ]; then
  dim "[dry] magpie plugin add $PLUGIN_DIR"
else
  add_out="$(run_magpie plugin add "$PLUGIN_DIR")"; add_code=$?
  [ -n "$add_out" ] && printf '%s\n' "$add_out"
  if [ "$add_code" -ne 0 ]; then
    err "plugin add 失败（exit $add_code）"
    echo "先手动跑一次确认原因：magpie plugin add \"$PLUGIN_DIR\""
    exit 2
  fi
fi

# ---------------------------------------------------------------- 5. 复核
if [ "$DRY" != "1" ]; then
  list="$(run_magpie plugin list)"
  case "$list" in
    *"$PROVIDER"*) ok "安装完成，$PROVIDER 已出现在插件列表。" ;;
    *)
      err "装完仍未在 plugin list 看到 $PROVIDER"
      [ -n "$list" ] && printf '%s\n' "$list"
      exit 3
      ;;
  esac
fi

# ---------------------------------------------------------------- 6. 登录
if [ "$LOGIN" = "1" ]; then
  step "登录 $PROVIDER（按提示粘贴 sk- 开头的 API Key，或 AK:SK 让插件自动签发 Key）"
  run_magpie_interactive plugin login "$PROVIDER"; login_code=$?
  if [ "$DRY" = "1" ]; then
    ok '（dry-run）只打印了将执行的 plugin login。'
  elif [ "$login_code" -eq 0 ]; then
    ok '登录流程结束。'
  else
    warn "登录未完成，可稍后手动执行：magpie plugin login $PROVIDER"
  fi
else
  echo; printf '%s下一步（登录）：%s\n' "$C_STEP" "$C_RST"
  echo "    magpie plugin login $PROVIDER"
  echo '  或重新运行本脚本并加 --login。'
  echo '  Key 在控制台拿：https://portal.qiniu.com/ai-inference/api-key'
fi

echo; ok '完成。'
echo '查看状态：magpie plugin list'
exit 0
