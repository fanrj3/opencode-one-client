#!/usr/bin/env node
// ocd —— opencode-one-client 命令行
//
// 用法:
//   ocd list                     列出设备及在线状态
//   ocd open <设备> [参数…]       用 OpenCode TUI 连接该设备（其余参数透传给 opencode）
//   ocd add <设备> --url <地址> [--password 密码] [--name 名称] [--platform posix|windows]
//                               添加/更新一台设备（联网验证；缺密码时交互输入）
//   ocd add --local              把本机加进配置（自动读取本机 OpenCode 服务密码）
//   ocd remove <设备>            从配置中移除设备
//   ocd invite                   在【设备端】运行：检测本机服务并输出一行可粘贴到主机的 ocd add 命令
//
// 配置文件: ~/.config/opencode/opencode-one-client.json
//（设置 XDG_CONFIG_HOME 时为 $XDG_CONFIG_HOME/opencode/opencode-one-client.json；也可用 --config 指定）

import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"

const rawArgs = process.argv.slice(2)
let configOverride
const args = []
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--config" && rawArgs[i + 1]) {
    configOverride = rawArgs[++i]
    continue
  }
  args.push(rawArgs[i])
}

function configPath() {
  if (configOverride) return configOverride
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(root, "opencode", "opencode-one-client.json")
}

function serviceJsonPath() {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(root, "opencode", "service.json")
}

// ---------- 配置读写 ----------

function loadDevices() {
  const p = configPath()
  let raw
  try {
    raw = readFileSync(p, "utf8")
  } catch {
    console.error(`ocd: 找不到配置文件 ${p}`)
    console.error("  添加第一台设备：ocd add --local（本机）或 ocd add <id> --url <地址>（远程）")
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error(`ocd: 配置文件不是合法 JSON: ${p}\n  ${error.message}`)
    process.exit(1)
  }
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.devices
  if (!Array.isArray(list)) {
    console.error(`ocd: 配置缺少 "devices" 数组: ${p}`)
    process.exit(1)
  }
  return list.filter((d) => d && d.id && d.url)
}

function loadConfigForWrite() {
  const p = configPath()
  let raw
  try {
    raw = readFileSync(p, "utf8")
  } catch {
    return { path: p, data: { devices: [] } }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    console.error(`ocd: 配置文件不是合法 JSON，已中止: ${p}\n  ${error.message}`)
    process.exit(1)
  }
  if (Array.isArray(data)) data = { devices: data }
  if (!Array.isArray(data.devices)) data.devices = []
  return { path: p, data }
}

function saveConfig(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
  try {
    chmodSync(path, 0o600)
  } catch {}
}

function readLocalService() {
  try {
    return JSON.parse(readFileSync(serviceJsonPath(), "utf8"))
  } catch {
    return undefined
  }
}

// ---------- 小工具 ----------

const VALUE_FLAGS = new Set(["url", "password", "name", "platform", "default-dir", "cwd", "open-hint", "id", "port"])
const BOOL_FLAGS = new Set(["local", "force"])

function parseFlags(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      pos.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      let key
      let value
      const eq = a.indexOf("=")
      if (eq !== -1) {
        key = a.slice(2, eq)
        value = a.slice(eq + 1)
      } else {
        key = a.slice(2)
        if (VALUE_FLAGS.has(key)) value = argv[++i]
      }
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true
        continue
      }
      if (!VALUE_FLAGS.has(key)) {
        console.error(`ocd: 未知参数 --${key}`)
        process.exit(1)
      }
      if (value === undefined) {
        console.error(`ocd: --${key} 需要一个值`)
        process.exit(1)
      }
      flags[key] = value
    } else {
      pos.push(a)
    }
  }
  return { flags, pos }
}

// 把 "127.0.0.1:49374"、"my-server"、"http://host" 之类都归一化为带 scheme+端口 的 URL
function normalizeUrl(input) {
  let u = String(input).trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u
  u = u.replace(/\/+$/, "")
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(u)
  if (!m) return u
  let host = m[1]
  const rest = m[2] || ""
  if (!/:\d+$/.test(host.split("://")[1])) host += ":49374"
  return host + rest
}

function tailscaleName() {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 4000 })
  if (r.status !== 0 || !r.stdout) return undefined
  try {
    const dns = JSON.parse(r.stdout)?.Self?.DNSName
    if (typeof dns === "string" && dns) return dns.replace(/\.$/, "")
  } catch {}
  return undefined
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function authHeaderFor(password) {
  return "Basic " + Buffer.from(`opencode:${password || ""}`).toString("base64")
}

async function probe(url, password) {
  try {
    const res = await fetch(url + "/api/info", {
      headers: { authorization: authHeaderFor(password) },
      signal: AbortSignal.timeout(4000),
    })
    let version
    try {
      version = (await res.json())?.version
    } catch {}
    return { status: res.status, version }
  } catch (error) {
    return { status: 0, error: String(error) }
  }
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (!stdin.isTTY || !process.stdout.isTTY) {
      let data = ""
      stdin.setEncoding("utf8")
      stdin.on("data", (chunk) => {
        data += chunk
        const nl = data.indexOf("\n")
        if (nl !== -1) {
          stdin.pause()
          resolve(data.slice(0, nl).trim())
        }
      })
      stdin.on("end", () => resolve(data.trim()))
      return
    }
    process.stdout.write(question)
    let buf = ""
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const cleanup = () => {
      stdin.removeListener("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup()
          process.stdout.write("\n")
          resolve(buf)
          return
        } else if (ch === "\u0003") {
          cleanup()
          process.stdout.write("\n")
          process.exit(130)
        } else if (ch === "\u007f") {
          if (buf) {
            buf = buf.slice(0, -1)
            process.stdout.write("\b \b")
          }
        } else if (ch >= " ") {
          buf += ch
          process.stdout.write("*")
        }
      }
    }
    stdin.on("data", onData)
  })
}

// ---------- 命令 ----------

function findDevice(devices, query) {
  const q = String(query).toLowerCase()
  return devices.find(
    (d) =>
      d.id === query ||
      String(d.id).toLowerCase() === q ||
      String(d.name || "").toLowerCase().includes(q),
  )
}

function ping(device) {
  return probe(device.url, device.password).then((r) => (r.status === 200 ? (r.version ?? "?") : null))
}

async function cmdList() {
  const devices = loadDevices()
  if (devices.length === 0) {
    console.log("（未配置任何设备）")
    return
  }
  for (const d of devices) {
    const v = await ping(d)
    console.log(`${d.id}  ${v ? `在线 · OpenCode v${v}` : "离线"}  ${d.url}`)
  }
}

function findOpencodeCLI() {
  const whichCmd = process.platform === "win32" ? "where" : "which"
  const found = spawnSync(whichCmd, ["opencode"], { encoding: "utf8" })
  if (found.status === 0) {
    const first = String(found.stdout)
      .split(/\r?\n/)
      .find((line) => line.trim())
    if (first) return first.trim()
  }
  const home = homedir()
  const candidates = [join(home, ".opencode", "bin", "opencode")]
  if (process.platform === "darwin") {
    candidates.push(join(home, ".local", "bin", "opencode"))
    const base = join(home, "Library", "Application Support", "ai.opencode.desktop", "cli")
    try {
      const dirs = readdirSync(base).sort().reverse()
      for (const dir of dirs) candidates.push(join(base, dir, "opencode-cli"))
    } catch {}
  } else if (process.platform === "win32") {
    candidates.push(join(home, ".opencode", "bin", "opencode.exe"))
  } else {
    candidates.push(join(home, ".local", "bin", "opencode"))
    candidates.push("/usr/local/bin/opencode")
    candidates.push("/usr/bin/opencode")
  }
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {}
  }
  return undefined
}

// 设备可配置 cwd（启动目录）：把不同设备的界面标签状态隔离开（客户端标签按启动目录分桶，共享目录会互相串台）。
function resolveCwd(device) {
  if (!device.cwd) return undefined
  let dir = String(device.cwd)
  if (dir === "~") dir = homedir()
  else if (dir.startsWith("~/")) dir = join(homedir(), dir.slice(2))
  mkdirSync(dir, { recursive: true })
  return dir
}

function cmdOpen() {
  const devices = loadDevices()
  const id = args[1]
  if (!id) {
    console.error("用法: ocd open <设备id> [opencode 参数…]")
    process.exit(1)
  }
  const device = findDevice(devices, id)
  if (!device) {
    console.error(`ocd: 没有叫「${id}」的设备。已配置：${devices.map((d) => d.id).join("、")}`)
    process.exit(1)
  }
  const cli = findOpencodeCLI()
  if (!cli) {
    console.error("ocd: 找不到 opencode CLI（请安装 OpenCode，并确保 opencode 在 PATH 中）")
    process.exit(1)
  }
  const child = spawn(cli, ["--server", device.url, ...args.slice(2)], {
    stdio: "inherit",
    cwd: resolveCwd(device),
    env: { ...process.env, OPENCODE_PASSWORD: device.password || "" },
  })
  child.on("exit", (code) => process.exit(code == null ? 1 : code))
}

async function cmdAdd() {
  const { flags, pos } = parseFlags(args.slice(1))
  const isLocal = !!flags.local
  let id = flags.id || pos[0]
  let url = flags.url
  let password = flags.password
  let name = flags.name
  let platform = flags.platform
  let defaultDir = flags["default-dir"]
  let cwd = flags.cwd
  let openHint = flags["open-hint"]

  if (!id && isLocal) {
    const tsLocal = tailscaleName()
    id = tsLocal ? tsLocal.split(".")[0] : hostname().split(".")[0]
  }
  if (!id) {
    console.error("用法: ocd add <设备id> --url <地址> [--password 密码]")
    console.error("  或: ocd add --local        （把本机加进配置）")
    process.exit(1)
  }

  const { path, data } = loadConfigForWrite()
  const existing = data.devices.find((d) => d && d.id === id)

  if (isLocal) {
    const svc = readLocalService()
    if (!url) url = `http://127.0.0.1:${flags.port || svc?.port || 49374}`
    if (!password) password = svc?.password
    if (!password) {
      console.error(`ocd: 没找到本机 OpenCode 服务密码（${serviceJsonPath()}）。`)
      console.error("  先把本机服务跑起来（桌面版 / opencode serve / opencode service start），或手动传 --password。")
      process.exit(1)
    }
    if (!platform) platform = process.platform === "win32" ? "windows" : "posix"
    if (!defaultDir) defaultDir = homedir()
  } else {
    if (!url && existing?.url) url = existing.url
    if (!url) {
      console.error("ocd: 缺少 --url（例如 --url http://my-server:49374）")
      process.exit(1)
    }
    if (!password) {
      if (existing?.password) {
        password = existing.password
      } else if (process.stdin.isTTY && process.stdout.isTTY) {
        password = await promptHidden(`请输入 ${id} 的服务密码: `)
      } else {
        console.error("ocd: 缺少 --password（非交互环境必须提供）")
        process.exit(1)
      }
    }
  }

  url = normalizeUrl(url)

  const result = await probe(url, password)
  if (result.status === 401 && !flags.force) {
    console.error(`❌ 密码不对（${url} 返回 401）。核对后重试；确认无误可加 --force 强制保存。`)
    process.exit(1)
  }

  const patch = { id, url, password }
  const put = (key, value) => {
    if (value !== undefined) patch[key] = value
  }
  put("name", name ?? existing?.name)
  put("platform", platform ?? existing?.platform)
  put("defaultDir", defaultDir ?? existing?.defaultDir)
  if (!existing) {
    put("cwd", cwd ?? `~/.local/state/opencode-one-client/launch/${id}`)
    put("openHint", openHint ?? `在终端运行 ocd open ${id} 打开它的界面`)
  } else {
    put("cwd", cwd ?? existing.cwd)
    put("openHint", openHint ?? existing.openHint)
  }

  if (existing) {
    Object.assign(existing, patch)
  } else {
    data.devices.push(patch)
  }
  saveConfig(path, data)

  const verb = existing ? "已更新" : "已添加"
  if (result.status === 200) {
    console.log(`✅ ${verb}「${id}」（在线 · OpenCode v${result.version}）　试试: ocd open ${id}`)
  } else if (result.status === 401) {
    console.log(`⚠️ 已保存「${id}」，但密码校验未通过（使用了 --force）。`)
  } else {
    console.log(`⚠️ 已保存「${id}」，但此刻连不上（${url}）。稍后可用 ocd list 检查。`)
  }
  console.log(`   配置: ${path}`)
}

function cmdRemove() {
  const id = args[1]
  if (!id) {
    console.error("用法: ocd remove <设备id>")
    process.exit(1)
  }
  const { path, data } = loadConfigForWrite()
  const before = data.devices.length
  data.devices = data.devices.filter(
    (d) => !(d && (d.id === id || String(d.id).toLowerCase() === id.toLowerCase())),
  )
  if (data.devices.length === before) {
    console.error(`ocd: 没有叫「${id}」的设备。已配置：${data.devices.map((d) => d.id).join("、") || "（空）"}`)
    process.exit(1)
  }
  saveConfig(path, data)
  console.log(`✅ 已移除「${id}」（配置文件: ${path}）`)
}

async function cmdInvite() {
  const { flags } = parseFlags(args.slice(1))
  const svc = readLocalService()
  if (!svc?.password) {
    console.error(`ocd: 没找到本机 OpenCode 服务配置（${serviceJsonPath()}）。`)
    console.error("  先在本机把服务跑起来（桌面版 / opencode serve / opencode service start），再运行 ocd invite。")
    process.exit(1)
  }
  const port = Number(flags.port) || svc.port || 49374
  const tsName = tailscaleName()
  const id = flags.id || (tsName ? tsName.split(".")[0] : hostname().split(".")[0])
  const url = flags.url ? normalizeUrl(flags.url) : `http://${tsName || hostname().split(".")[0]}:${port}`
  const platform = flags.platform || (process.platform === "win32" ? "windows" : "posix")

  const candidates = [`http://127.0.0.1:${port}`]
  if (svc.hostname && !["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(svc.hostname)) {
    candidates.push(`http://${svc.hostname}:${port}`)
  }
  let healthy
  for (const url of candidates) {
    const r = await probe(url, svc.password)
    if (r.status === 200) {
      healthy = { url, version: r.version }
      break
    }
  }
  if (healthy) {
    const how = healthy.url.includes("127.0.0.1") ? "" : `，绑定 ${svc.hostname}`
    console.log(`✅ 本机服务正常（OpenCode v${healthy.version}，端口 ${port}${how}）`)
  } else {
    console.log(`⚠️ 本机没有 OpenCode 服务在响应（试过 ${candidates.join("、")}）—— 先把服务跑起来再邀请。`)
  }

  const bind = svc.hostname
  if (!bind || bind === "127.0.0.1" || bind === "::1" || bind === "localhost") {
    console.log("")
    console.log("⚠️ 服务只监听本机回环（127.0.0.1），其他机器连不上。先执行：")
    console.log("    opencode service set hostname 0.0.0.0 && opencode service start")
    console.log("  （更稳妥的做法是只绑定 Tailscale 地址：opencode service set hostname <你的 100.x.x.x>）")
  }
  if (!tsName) {
    console.log("")
    console.log(`ℹ️ 没检测到 Tailscale。请确认主机名「${hostOf(url)}」在对方机器的网络里可解析 / 可达。`)
  }
  console.log("")
  console.log("📋 把这行命令复制到【你平时的主机】上粘贴运行，即可添加这台设备：")
  console.log("")
  console.log(`  ocd add ${id} --url ${url} --password '${svc.password}' --platform ${platform}`)
  console.log("")
  console.log(`（加完在那台机器上运行 ocd list 验证，ocd open ${id} 直接连接）`)
}

const HELP = `ocd —— opencode-one-client 命令行

用法:
  ocd list                     列出设备及在线状态
  ocd open <设备> [参数…]       用 OpenCode TUI 连接该设备
  ocd add <设备> --url <地址> [--password 密码] [--name 名称] [--platform posix|windows]
                               添加/更新设备（联网验证；缺密码时交互输入）
  ocd add --local              把本机加进配置（自动读取本机服务密码）
  ocd remove <设备>            移除设备
  ocd invite                   在【设备端】运行：输出一行可粘贴到主机的 ocd add 命令

配置文件: ~/.config/opencode/opencode-one-client.json（--config 指定其它路径）
`

async function main() {
  const cmd = args[0]
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP)
    return
  }
  if (cmd === "list" || cmd === "ls") return cmdList()
  if (cmd === "open") return cmdOpen()
  if (cmd === "add") return cmdAdd()
  if (cmd === "remove" || cmd === "rm") return cmdRemove()
  if (cmd === "invite") return cmdInvite()
  console.log(HELP)
  process.exit(cmd ? 1 : 0)
}

await main()
