// _tools/verify.mjs —— 本机一键验收（CONTRACT §7 的顺序）
// 零外部依赖：只用 node:child_process / node:fs / node:path / node:process。
// 不联网、不碰 ~/.config/magpie、不写真状态：dry-run 用 /bin/true 桩，e2e 用 fake-magpie 桩。
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(path.dirname(process.argv[1] || process.cwd()), "..");
// 计时用单调时钟：Bun 的 spawnSync 阻塞期间 Date.now() 可能不推进，hrtime 不会。
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const FIXED_BUN = "C:\\Users\\c\\AppData\\Local\\Temp\\bun-node-a7733435c\\bun.exe";

function isFile(p) {
  try {
    return Boolean(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function probe(cmd, args) {
  if (!cmd) return false;
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000, stdio: "pipe" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

// bun 探测：BUN_BIN → 固定临时路径 → PATH。
function findBun() {
  if (process.env.BUN_BIN && isFile(process.env.BUN_BIN)) return process.env.BUN_BIN;
  if (isFile(FIXED_BUN)) return FIXED_BUN;
  if (probe("bun", ["--version"])) return "bun";
  return null;
}

// node 只用于 --check 与 smoke；本机只有 bun 时退回 bun --check / bun run。
function findNode(bun) {
  const cands = [
    process.env.NODE_BIN,
    "node",
    path.join(path.dirname(bun), process.platform === "win32" ? "node.exe" : "node"),
  ];
  for (const c of cands) if (c && probe(c, ["-p", "process.version"])) return c;
  return null;
}

function findBash() {
  const cands =
    process.platform === "win32"
      ? [process.env.BASH_BIN, "bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
      : [process.env.BASH_BIN, "bash", "/bin/bash", "/usr/bin/bash"];
  for (const c of cands) if (c && probe(c, ["-c", "exit 0"])) return c;
  return null;
}

function findPowerShell() {
  for (const c of ["pwsh", "powershell.exe", "powershell"]) {
    if (probe(c, ["-NoProfile", "-Command", "exit 0"])) return c;
  }
  return null;
}

let passed = 0;
let failed = 0;
let skipped = 0;

function exec(cmd, args, opts = {}) {
  try {
    return spawnSync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
    });
  } catch (e) {
    return { status: -1, error: e, stdout: "", stderr: "" };
  }
}

function finish(name, r, t0) {
  const ms = nowMs() - t0;
  if (r && !r.error && r.status === 0) {
    console.log("[ok] " + name + "（" + ms + "ms）");
    passed += 1;
    return true;
  }
  console.error("[fail] " + name + "（" + ms + "ms）");
  if (r && r.file) console.error("    文件: " + r.file);
  const lines = [r && r.error && r.error.message, r && r.stderr, r && r.stdout]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-20);
  for (const line of lines) console.error("    " + line);
  if (r && typeof r.status === "number" && !r.error) console.error("    退出码: " + r.status);
  failed += 1;
  return false;
}

function run(name, cmd, args, opts) {
  const t0 = nowMs();
  return finish(name, exec(cmd, args, opts), t0);
}

function skip(name, why) {
  console.log("[skip] " + name + " — " + why);
  skipped += 1;
}

const bun = findBun();
if (!bun) {
  console.error("[x] 找不到 bun：请设置环境变量 BUN_BIN 指向 bun.exe，或确认固定路径 " + FIXED_BUN + " 存在，或把 bun 加入 PATH。");
  process.exit(1);
}

const nodeBin = findNode(bun);
const bash = findBash();
const ps = findPowerShell();

console.log("契约验收：" + repoRoot);
console.log(
  "bun=" + bun +
    "；node=" + (nodeBin || "未找到（改用 bun --check / bun run）") +
    "；bash=" + (bash || "未找到") +
    "；PowerShell=" + (ps || "未找到"),
);
console.log("");

// §7.1 语法检查：glob 只作 --check 的第一个参数，必须逐文件跑才覆盖全部源码。
{
  const t0 = nowMs();
  const srcFiles = readdirSync(path.join(repoRoot, "plugin", "src"))
    .filter((f) => f.endsWith(".mjs"))
    .sort()
    .map((f) => path.join("plugin", "src", f));
  const files = [path.join("plugin", "index.mjs"), ...srcFiles];
  let bad = null;
  for (const f of files) {
    const r = exec(nodeBin || bun, ["--check", f]);
    if (!r || r.error || r.status !== 0) {
      bad = r || {};
      bad.file = f;
      break;
    }
  }
  finish("语法检查：node --check 共 " + files.length + " 个 .mjs", bad || { status: 0 }, t0);
}

// §7.2 smoke
{
  const t0 = nowMs();
  const r = nodeBin
    ? exec(nodeBin, [path.join("plugin", "tests", "smoke.mjs")])
    : exec(bun, ["run", path.join("plugin", "tests", "smoke.mjs")]);
  finish("smoke：plugin/tests/smoke.mjs", r, t0);
}

// §7.3 / §7.4
run("bun test plugin/tests", bun, ["test", "plugin/tests"]);
run("bun test tests/e2e", bun, ["test", "tests/e2e"]);

// §7.5
if (!bash) {
  skip("bash -n install.sh", "未找到 bash");
  skip("bash install.sh --help", "未找到 bash");
  skip("bash install.sh --dry-run", "未找到 bash");
} else {
  run("bash -n install.sh", bash, ["-n", "install.sh"]);
  run("bash install.sh --help", bash, ["install.sh", "--help"]);
  run("bash install.sh --dry-run（MAGPIE_BIN=/bin/true）", bash, ["install.sh", "--dry-run"], {
    env: { MAGPIE_BIN: "/bin/true" },
  });
}

// §7.6
if (!ps) {
  skip("PowerShell 解析 install.ps1", "未找到 pwsh/powershell");
} else {
  const target = path.join(repoRoot, "install.ps1").replace(/\\/g, "/").replace(/'/g, "''");
  const command =
    "$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
    target +
    "', [ref]$null, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { Write-Error $_.Message }; exit 1 }";
  run("PowerShell 解析 install.ps1", ps, ["-NoProfile", "-Command", command]);
}

console.log("");
console.log("汇总：" + passed + " passed / " + failed + " failed / " + skipped + " SKIP");
process.exit(failed > 0 ? 1 : 0);
