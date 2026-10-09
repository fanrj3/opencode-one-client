// 自检脚本（不影响正常使用）：
//   cd <本包目录> && node selftest.mjs [deviceId ...]
// 做三件事：ping 设备、列项目；对每台设备做「建临时目录 → 建会话 → 删会话 → 删目录」。
import { CONFIG_ERROR, DEVICES, selftestDir } from "./devices.js"
import {
  createSession,
  ensureDir,
  http,
  isDir,
  listProjects,
  ping,
  ptyRun,
  sleep,
  visibleProjects,
} from "./lib.js"

if (CONFIG_ERROR) console.log(`[config] ${CONFIG_ERROR}`)
if (DEVICES.length === 0) {
  console.log("没有配置设备，退出。")
  process.exit(1)
}

const wanted = process.argv.slice(2)
const list = wanted.length ? DEVICES.filter((d) => wanted.includes(d.id)) : DEVICES

for (const device of list) {
  console.log(`\n=== ${device.id} (${device.url}) ===`)
  const p = await ping(device)
  console.log("ping:", p.ok ? `OK v${p.version}` : `FAIL status=${p.status}`)
  if (!p.ok) continue
  const projects = visibleProjects(device, await listProjects(device))
  console.log("projects:", projects.length, "|", projects.slice(0, 4).map((x) => x.canonical).join("  ·  "))
}

for (const device of list) {
  const p = await ping(device)
  if (!p.ok) continue
  const dir = selftestDir(device)
  console.log(`\n[e2e ${device.id}] ensureDir ${dir}`)
  const ok = await ensureDir(device, dir)
  console.log("  ensureDir:", ok, "| isDir:", await isDir(device, dir))
  if (!ok) continue

  const session = await createSession(device, dir, "自检临时会话（将删除）")
  console.log("  session:", session.id)

  const command = device.platform === "windows" ? "cmd" : "rm"
  const args = device.platform === "windows" ? ["/c", "rmdir", "/s", "/q", dir] : ["-rf", dir]
  const ptyID = await ptyRun(device, command, args)
  await sleep(1200)
  if (ptyID) await http(device, `/api/pty/${ptyID}`, { method: "DELETE" })
  console.log("  dir removed:", !(await isDir(device, dir)))

  const del = await http(device, `/api/session/${session.id}`, { method: "DELETE" })
  console.log("  session deleted:", del.ok, `(HTTP ${del.status})`)
}

console.log("\ndone")
