#!/usr/bin/env node
// tests/e2e/fake-magpie.mjs —— 假的 magpie CLI，用来端到端验证安装脚本
//
// 只实现安装脚本真正会调的五个命令：
//   magpie --version
//   magpie plugin list
//   magpie plugin add <dir>
//   magpie plugin rm|remove <spec>
//   magpie plugin login [providerId]
//
// 状态落在 $FAKE_MAGPIE_STATE（默认系统临时目录），测试据此断言
// 「装上了 / 重装过 / 卸载了 / rm 与 add 的先后」。
//
// 每次调用都往 stderr 写一行启动噪声：真 magpie.com 就是这么干的，
// 安装脚本必须把它丢掉（ps1 用 2>$null，sh 用 2>/dev/null），
// 于是 stdout 里出现噪声即回归。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const STATE = process.env.FAKE_MAGPIE_STATE || join(tmpdir(), "fake-magpie-qiniu-state.json")
const PROVIDER = "qiniu-ai"
const PKG = "magpie-qiniu-lite"

process.stderr.write("[fake-magpie] startup notice on stderr (installer must discard this)\n")

function load() {
  try {
    if (!existsSync(STATE)) return blank()
    const s = JSON.parse(readFileSync(STATE, "utf8"))
    return {
      installed: Array.isArray(s.installed) ? s.installed : [],
      adds: typeof s.adds === "number" ? s.adds : 0,
      removes: typeof s.removes === "number" ? s.removes : 0,
      logins: typeof s.logins === "number" ? s.logins : 0,
      ops: Array.isArray(s.ops) ? s.ops : [],
    }
  } catch {
    return blank()
  }
}

function blank() {
  return { installed: [], adds: 0, removes: 0, logins: 0, ops: [] }
}

function save(state) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8")
}

function readPkg(dir) {
  const p = join(dir, "package.json")
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
}

// Git Bash 传过来的规格是 /c/Users/… 这种 POSIX 形式，win32 上的 Node 需要盘符形式
function toNative(p) {
  if (!p) return p
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p)
    if (m) return `${m[1].toUpperCase()}:${m[3] ? "\\" + m[3].replace(/\//g, "\\") : "\\"}`
  }
  return p
}

function sameSpec(a, b) {
  const x = toNative(a)
  const y = toNative(b)
  if (!x || !y) return false
  try {
    return resolve(x) === resolve(y)
  } catch {
    return x === y
  }
}

const argv = process.argv.slice(2)
const [first, ...rest] = argv

if (first === "--version" || first === "-v" || first === "version") {
  console.log("magpie 9.9.9-fake")
  process.exit(0)
}

if (first !== "plugin") {
  process.stderr.write(`fake-magpie: 不支持的命令 ${argv.join(" ") || "(空)"}\n`)
  process.exit(64)
}

const sub = rest[0]

if (sub === "list") {
  const state = load()
  if (!state.installed.length) {
    console.log("no plugins installed")
    process.exit(0)
  }
  for (const it of state.installed) {
    // 必须含字面量 provider id：安装脚本的复核就是 grep 它
    console.log(`${PROVIDER} (${it.name}, ${it.version}) <- ${it.spec}`)
  }
  process.exit(0)
}

if (sub === "add") {
  const spec = rest[1]
  if (!spec) {
    process.stderr.write("fake-magpie: plugin add 需要目录或规格\n")
    process.exit(64)
  }
  const dir = resolve(toNative(spec))
  const pkg = readPkg(dir)
  if (!pkg) {
    process.stderr.write(`fake-magpie: ${dir} 下没有 package.json\n`)
    process.exit(2)
  }
  if (pkg.name !== PKG) {
    process.stderr.write(`fake-magpie: 包名不对：${pkg.name} != ${PKG}\n`)
    process.exit(2)
  }
  const state = load()
  const hit = state.installed.find((x) => sameSpec(x.spec, dir))
  if (hit) {
    hit.version = pkg.version
  } else {
    state.installed.push({ spec: dir, name: pkg.name, version: pkg.version })
  }
  state.adds += 1
  state.ops.push("add")
  save(state)
  console.log(`added ${pkg.name}@${pkg.version} from ${dir}`)
  process.exit(0)
}

if (sub === "rm" || sub === "remove") {
  const spec = rest[1]
  if (!spec) {
    process.stderr.write("fake-magpie: plugin rm 需要目录或规格\n")
    process.exit(64)
  }
  const state = load()
  const before = state.installed.length
  state.installed = state.installed.filter(
    (x) => !sameSpec(x.spec, spec) && x.name !== spec && spec !== PROVIDER,
  )
  if (state.installed.length === before) {
    process.stderr.write(`fake-magpie: 没找到 ${spec}\n`)
    process.exit(1)
  }
  state.removes += 1
  state.ops.push("rm")
  save(state)
  console.log(`removed ${spec}`)
  process.exit(0)
}

if (sub === "login") {
  const wanted = rest[1]
  if (wanted && wanted !== PROVIDER) {
    process.stderr.write(`fake-magpie: 不认识这个 provider：${wanted}\n`)
    process.exit(64)
  }
  const state = load()
  state.logins += 1
  state.ops.push("login")
  save(state)
  console.log(`logged in ${PROVIDER} (fake, 未写任何真实凭据)`)
  process.exit(0)
}

process.stderr.write(`fake-magpie: 不支持的子命令 plugin ${sub}\n`)
process.exit(64)
