// tests/e2e/installer.test.mjs —— 端到端：用假 magpie 真跑一遍安装脚本
//
// 覆盖 dry-run 之外的真实链路：
//   装 → 状态里真有 qiniu-ai → 再装（不 rm）→ --force（先 rm 再 add）→ --uninstall
// 外加契约里的三条退出码：源码缺失/包名不符 = 2，未知参数 = 1，找不到 magpie = 1。
//
// 两端各跑一遍：install.ps1 用 pwsh/powershell 探测，install.sh 用 bash 探测；
// 探不到宿主机就 t.skip()，不 fail（CONTRACT §7：本机可能没有 pwsh / CI 可能没有 node）。
//
// 假 magpie 见同目录 fake-magpie.mjs，状态落在临时文件里，测试据此断言。

import test from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..", "..")
const isWin = process.platform === "win32"
const stubMjs = join(here, "fake-magpie.mjs")
const shBin = join(here, "fake-magpie")
const cmdBin = join(here, "fake-magpie.cmd")

// 包装器里调的是 `node`：把当前运行时所在目录塞进 PATH，
// 这样在没装全局 node 的机器上也能跑（本机只有 bun，bun.exe 旁边就是 node.exe）
const RUNTIME_DIR = dirname(process.execPath)
const PATH_WITH_NODE = [RUNTIME_DIR, process.env.PATH].filter(Boolean).join(delimiter)

// 两端参数名不同：PowerShell 是 -DryRun，bash 是 --dry-run
const FLAGS = {
  dryRun: { sh: "--dry-run", ps: "-DryRun" },
  force: { sh: "--force", ps: "-Force" },
  uninstall: { sh: "--uninstall", ps: "-Uninstall" },
  yes: { sh: "--yes", ps: "-Yes" },
  login: { sh: "--login", ps: "-Login" },
  noColor: { sh: "--no-color", ps: "-NoColor" },
  help: { sh: "--help", ps: "-Help" },
}

const EMPTY_STATE = { installed: [], adds: 0, removes: 0, logins: 0, ops: [] }

function probe(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return !r.error && r.status === 0
}

// 返回可执行文件的绝对路径：后面的用例要把 PATH 收窄来验「找不到 magpie」，
// 那时靠命令名找宿主就会 ENOENT。
function findBash() {
  const cands = isWin
    ? ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
    : ["bash", "/bin/bash"]
  for (const c of cands) {
    if (probe(c, ["-c", "exit 0"])) return c
  }
  return null
}

function findPs() {
  for (const c of ["pwsh", "powershell.exe", "powershell"]) {
    if (!probe(c, ["-NoProfile", "-Command", "exit 0"])) continue
    const r = spawnSync(c, ["-NoProfile", "-Command", "(Get-Process -Id $PID).Path"], { encoding: "utf8" })
    const abs = (r.stdout || "").trim().split(/\r?\n/)[0]
    if (abs && existsSync(abs)) return abs
    return c
  }
  return null
}

// Git Bash 眼里 C:\a\b 要写成 /c/a/b；POSIX 侧原样返回
function toPosix(p) {
  if (!isWin) return p
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!m) return p
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`
}

function readState(runner) {
  if (!existsSync(runner.statePath)) return { ...EMPTY_STATE, installed: [] }
  return JSON.parse(readFileSync(runner.statePath, "utf8"))
}

function argvFor(kind, flags) {
  return Object.keys(FLAGS)
    .filter((name) => flags[name])
    .map((name) => FLAGS[name][kind])
}

function makeRunner(kind) {
  const dir = mkdtempSync(join(tmpdir(), `qiniu-e2e-${kind}-`))
  const statePath = join(dir, "statePath.json")
  const runner = {
    kind,
    dir,
    statePath,
    script: join(repoRoot, kind === "ps" ? "install.ps1" : "install.sh"),
    bin: kind === "ps" ? (isWin ? cmdBin : toPosix(shBin)) : toPosix(shBin),
    cmd: null,
  }
  if (kind === "ps") {
    runner.cmd = findPs()
    runner.prefix = (script, argv) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...argv]
  } else {
    runner.cmd = findBash()
    runner.prefix = (script, argv) => [script, ...argv]
  }
  // POSIX 上两种用例都用同一个 bash 桩（pwsh 在 Linux 会直接 exec 带 shebang 的文件，
  // .cmd 在那边只会被 xdg-open 当成文档去「打开」）；Windows 上 ps 用例仍用 .cmd 桩。
  if (!isWin || kind !== "ps") {
    try {
      chmodSync(shBin, 0o755)
    } catch {
      /* Windows 上 chmod 是 no-op，Git Bash 一般已经把普通文件当可执行 */
    }
  }
  return runner
}

function exec(runner, flags, { env = {}, script, cwd = repoRoot, extraArgs = [] } = {}) {
  const target = script || runner.script
  const argv = runner.prefix(target, [...argvFor(runner.kind, { noColor: true, ...flags }), ...extraArgs])
  return new Promise((resolve, reject) => {
    const child = spawn(runner.cmd, argv, {
      cwd,
      env: {
        ...process.env,
        PATH: PATH_WITH_NODE,
        MAGPIE_BIN: runner.bin,
        FAKE_MAGPIE_STATE: runner.statePath,
        ...env,
      },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function mkEmptyRepoDir(runner, pkg = null) {
  const empty = mkdtempSync(join(tmpdir(), "qiniu-e2e-empty-"))
  const scriptName = runner.kind === "ps" ? "install.ps1" : "install.sh"
  copyFileSync(runner.script, join(empty, scriptName))
  if (pkg) {
    mkdirSync(join(empty, "plugin"), { recursive: true })
    writeFileSync(join(empty, "plugin", "package.json"), JSON.stringify(pkg, null, 2), "utf8")
    writeFileSync(join(empty, "plugin", "index.mjs"), "export default {}\n", "utf8")
  }
  return { empty, script: join(empty, scriptName) }
}

// ---------------------------------------------------------------- 可用宿主
const runners = []
const psHost = findPs()
const bashPath = findBash()
if (isWin) {
  if (psHost) runners.push(makeRunner("ps"))
  if (bashPath) runners.push(makeRunner("sh"))
} else {
  if (bashPath) runners.push(makeRunner("sh"))
  if (psHost) runners.push(makeRunner("ps"))
}

const STDERR_NOISE = "startup notice on stderr"

test("桩本身可用：--version / 未知命令 exit 64", async () => {
  const run = (args) => spawnSync(process.execPath, [stubMjs, ...args], { encoding: "utf8" })
  const v = run(["--version"])
  assert.equal(v.status, 0)
  assert.match(v.stdout, /magpie 9\.9\.9-fake/)

  const list = run(["plugin", "list"])
  assert.equal(list.status, 0)
  assert.match(list.stderr, new RegExp(STDERR_NOISE), "桩要像真 magpie 那样往 stderr 写噪声")

  const bad = run(["nonsense"])
  assert.equal(bad.status, 64)
})

if (!runners.length) {
  test("安装脚本端到端", (t) => t.skip("本机既没有 PowerShell 也没有 bash，跳过端到端"))
}

for (const runner of runners) {
  const tag = `[${runner.kind}]`

  test.after(() => rmSync(runner.dir, { recursive: true, force: true }))

  test(`${tag} --help 退出 0 且列出退出码`, async () => {
    const r = await exec(runner, { help: true })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /qiniu-ai/)
    assert.match(r.stdout, /退出码/)
  })

  test(`${tag} dry-run：退出 0、不碰状态、只打印命令`, async () => {
    const r = await exec(runner, { dryRun: true })
    assert.equal(r.code, 0, `dry-run 应成功，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
    assert.equal(readState(runner).adds, 0, "dry-run 不应写入状态")
    assert.match(r.stdout, /\[dry\] magpie plugin add /, "应打印 plugin add")
    assert.doesNotMatch(r.stdout, new RegExp(STDERR_NOISE), "stderr 噪声不许混进 stdout")
  })

  test(`${tag} 首次安装：状态里真有 qiniu-ai`, async () => {
    const r = await exec(runner, {})
    assert.equal(r.code, 0, `安装应成功，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)

    const st = readState(runner)
    assert.equal(st.installed.length, 1, "应装上一个插件")
    assert.equal(st.installed[0].name, "magpie-qiniu-lite")
    assert.equal(st.adds, 1)
    assert.match(r.stdout, /qiniu-ai/, "复核阶段应看到 provider id")
    assert.match(r.stdout, /magpie-qiniu-lite@/, "plugin add 的回显应透传到 stdout")
    assert.doesNotMatch(r.stdout, new RegExp(STDERR_NOISE))
  })

  test(`${tag} 已装再装（不带 --force）：adds 递增但不产生第二条`, async () => {
    const r = await exec(runner, {})
    assert.equal(r.code, 0, r.stderr)
    const st = readState(runner)
    assert.equal(st.adds, 2, "add 会再执行一次")
    assert.equal(st.removes, 0, "不带 --force 不应 rm")
    assert.equal(st.installed.length, 1, "重复安装不该多出一条")
  })

  test(`${tag} --force：先 rm 再 add`, async () => {
    const r = await exec(runner, { force: true })
    assert.equal(r.code, 0, r.stderr)
    const st = readState(runner)
    assert.deepEqual(st.ops.slice(-2), ["rm", "add"], "--force 必须先 plugin rm 再 plugin add")
    assert.equal(st.removes, 1)
    assert.equal(st.adds, 3)
    assert.equal(st.installed.length, 1, "重装后仍只有一个")
  })

  test(`${tag} --login：调用 plugin login qiniu-ai`, async () => {
    const r = await exec(runner, { login: true })
    assert.equal(r.code, 0, r.stderr)
    const st = readState(runner)
    assert.equal(st.logins, 1, "应真的走了一次 login")
    assert.match(r.stdout, /magpie plugin login qiniu-ai|登录流程结束/)
  })

  test(`${tag} --uninstall --yes：清干净`, async () => {
    const r = await exec(runner, { uninstall: true, yes: true })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readState(runner).installed.length, 0, "卸载后不应再有插件")
  })

  test(`${tag} 脚本单独拷到空目录：exit 2`, async () => {
    const { empty, script } = mkEmptyRepoDir(runner)
    try {
      const r = await exec(runner, {}, { script, cwd: empty })
      assert.equal(r.code, 2, `缺插件源码应退出 2，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test(`${tag} 包名不符：exit 2`, async () => {
    const { empty, script } = mkEmptyRepoDir(runner, { name: "magpie-something-else", version: "9.9.9" })
    try {
      const r = await exec(runner, {}, { script, cwd: empty })
      assert.equal(r.code, 2, `包名不符应退出 2，实际 ${r.code}\n${r.stdout}`)
      assert.match(r.stdout, /包名校验失败/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test(`${tag} 未知参数：exit 1`, async () => {
    const bogus = runner.kind === "ps" ? "-Bogus" : "--bogus"
    const r = await exec(runner, { dryRun: true }, { extraArgs: [bogus] })
    assert.equal(r.code, 1, `未知参数应退出 1，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /未知参数/)
  })

  test(`${tag} 没有 magpie：exit 1 并给出可操作提示`, async () => {
    const narrowPath = isWin
      ? [RUNTIME_DIR, "C:\\Windows\\System32"].join(delimiter)
      : "/usr/bin:/bin"
    const r = await exec(runner, { dryRun: true }, { env: { PATH: narrowPath, MAGPIE_BIN: join(runner.dir, "no-such-magpie") } })
    assert.equal(r.code, 1, `找不到 magpie 应退出 1，实际 ${r.code}\n${r.stdout}`)
    assert.match(r.stdout, /没找到 magpie/)
    assert.match(r.stdout, /MAGPIE_BIN/)
  })
}
