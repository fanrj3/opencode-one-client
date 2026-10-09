// 设备清单加载器：从 ~/.config/opencode/opencode-one-client.json 读取
//（若设置了 XDG_CONFIG_HOME，则为 $XDG_CONFIG_HOME/opencode/opencode-one-client.json）。
// 字段说明见插件 README；示例见同目录 opencode-one-client.example.json。
// 文件缺失或损坏时：DEVICES 为空数组，CONFIG_ERROR 给出原因（命令会弹提示）。
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
export const CONFIG_PATH = join(CONFIG_DIR, "opencode-one-client.json")

function isWindowsPath(value) {
  const dir = String(value ?? "")
  return /^[A-Za-z]:/.test(dir) || dir.startsWith("\\\\")
}

function loadConfig() {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, "utf8")
  } catch {
    return {
      devices: [],
      error: `未找到配置文件：${CONFIG_PATH}\n请在终端运行 ocd add 添加设备（或参考插件目录的 opencode-one-client.example.json 手动创建）。`,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { devices: [], error: `配置文件不是合法 JSON：${CONFIG_PATH}\n${String(error)}` }
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.devices
  if (!Array.isArray(list)) {
    return { devices: [], error: `配置文件缺少 "devices" 数组：${CONFIG_PATH}` }
  }
  const devices = []
  const problems = []
  for (const item of list) {
    if (!item || typeof item !== "object" || !item.id || !item.url) {
      problems.push(`已跳过无效设备条目（需要 id 与 url）：${JSON.stringify(item).slice(0, 100)}`)
      continue
    }
    devices.push({
      ...item,
      platform: item.platform || (isWindowsPath(item.defaultDir) ? "windows" : "posix"),
      hideExact: Array.isArray(item.hideExact) ? item.hideExact : [],
      hidePrefix: Array.isArray(item.hidePrefix) ? item.hidePrefix : [],
    })
  }
  return { devices, error: problems.length ? problems.join("\n") : undefined }
}

const loaded = loadConfig()
export const DEVICES = loaded.devices
export const CONFIG_ERROR = loaded.error

// 「输入其他路径」时的占位示例：设备可自定义 promptExample，否则按平台给通用示例。
export function promptExample(device) {
  if (device.promptExample) return device.promptExample
  return device.platform === "windows"
    ? "例如 D:\\projects\\new-project"
    : "例如 /home/user/projects/new-project"
}

// 自检脚本用的测试目录：可自定义 testDir，否则在 defaultDir 下放 __oc_selftest__。
export function selftestDir(device) {
  if (device.testDir) return device.testDir
  const base = String(device.defaultDir || (device.platform === "windows" ? "C:\\" : "/home")).replace(/[\\/]+$/, "")
  return device.platform === "windows" ? `${base}\\__oc_selftest__` : `${base}/__oc_selftest__`
}
