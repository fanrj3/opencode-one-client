import { Plugin } from "@opencode/plugin/tui"
import { CONFIG_ERROR, DEVICES, promptExample } from "./devices.js"
import {
  baseName,
  createSession,
  ensureDir,
  isDir,
  listProjects,
  ping,
  visibleProjects,
} from "./lib.js"

type Ctx = any
type Device = any

const EMPTY_STATE = () => ({ lastDir: {}, pending: [] } as any)

// ---------- 共享状态：写入 ~/.config/opencode/opencode-one-client.state.json（桌面版与各终端 TUI 互通），并镜像到 ctx.storage ----------
let fsmod: any
let osmod: any
let pathmod: any
let fsReady: boolean | undefined

async function initFs() {
  if (fsReady !== undefined) return fsReady
  try {
    fsmod = await import("node:fs")
    osmod = await import("node:os")
    pathmod = await import("node:path")
    fsReady = true
  } catch {
    fsReady = false
  }
  return fsReady
}

function stateFile() {
  const root = process.env.XDG_CONFIG_HOME || pathmod.join(osmod.homedir(), ".config")
  return pathmod.join(root, "opencode", "opencode-one-client.state.json")
}

async function readFileState(): Promise<any | undefined> {
  if (!(await initFs())) return undefined
  try {
    return JSON.parse(fsmod.readFileSync(stateFile(), "utf8"))
  } catch {
    return undefined
  }
}

async function writeFileState(value: any) {
  if (!(await initFs())) return
  try {
    fsmod.writeFileSync(stateFile(), JSON.stringify(value, null, 2))
  } catch {}
}

function readCtxState(ctx: Ctx) {
  const [state] = ctx.storage.store("state", { initial: EMPTY_STATE() })
  const value = typeof state === "function" ? state() : state
  return value ?? EMPTY_STATE()
}

function mergePending(a: any[] = [], b: any[] = []) {
  const map = new Map<string, any>()
  for (const item of [...a, ...b]) if (item?.sessionID) map.set(item.sessionID, item)
  return [...map.values()].sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0))
}

async function readState(ctx: Ctx) {
  const ctxState = readCtxState(ctx)
  const file = await readFileState()
  if (!file) return ctxState
  return {
    lastDir: { ...(ctxState.lastDir ?? {}), ...(file.lastDir ?? {}) },
    pending: mergePending(ctxState.pending, file.pending),
  }
}

async function updateState(ctx: Ctx, mutate: (draft: any) => void) {
  const draft: any = JSON.parse(JSON.stringify(await readState(ctx)))
  mutate(draft)
  await writeFileState(draft)
  try {
    const [, update] = ctx.storage.store("state", { initial: EMPTY_STATE() })
    await update((target: any) => {
      target.lastDir = draft.lastDir
      target.pending = draft.pending
    })
  } catch {}
  return draft
}

async function isConnectedServer(ctx: Ctx, sessionID: string) {
  try {
    const res: any = await ctx.client.session.get({ sessionID })
    const data = res?.data ?? res
    return data?.id === sessionID
  } catch {
    return false
  }
}

async function requireConfig(ctx: Ctx) {
  if (DEVICES.length > 0) return true
  await ctx.ui.dialog.alert({
    title: "没有配置设备",
    message: CONFIG_ERROR ?? "请在终端运行 ocd add 添加设备，或编辑 ~/.config/opencode/opencode-one-client.json（参考插件 README）。",
  })
  return false
}

async function pickDevice(ctx: Ctx, title: string): Promise<Device | undefined> {
  if (!(await requireConfig(ctx))) return undefined
  const results = await Promise.all(
    DEVICES.map(async (device: Device) => ({ device, status: await ping(device) })),
  )
  if (!results.some((r) => r.status.ok)) {
    await ctx.ui.dialog.alert({
      title: "没有可用设备",
      message: "所有设备都连不上（检查 Tailscale 或设备上的服务是否启动）。",
    })
    return undefined
  }
  const id = await ctx.ui.dialog.select({
    title,
    options: results.map(({ device, status }) => ({
      title: device.name,
      value: device.id,
      description: status.ok ? `在线 · OpenCode v${status.version}` : "离线（无法连接）",
      disabled: !status.ok,
    })),
  })
  return DEVICES.find((d: Device) => d.id === id)
}

async function createAndOpen(ctx: Ctx, device: Device, dir: string) {
  if (!(await isDir(device, dir))) {
    const create = await ctx.ui.dialog.confirm({
      title: "目录不存在",
      message: `${dir}\n\n在「${device.name}」上创建这个文件夹并继续？`,
      label: { confirm: "创建", cancel: "取消" },
    })
    if (!create) return
    ctx.ui.toast.show({ title: "正在创建文件夹…", message: dir })
    const ok = await ensureDir(device, dir)
    if (!ok) {
      await ctx.ui.dialog.alert({
        title: "创建文件夹失败",
        message: `无法在 ${device.name} 上创建目录：\n${dir}`,
      })
      return
    }
  }
  let session: any
  try {
    session = await createSession(device, dir, baseName(dir))
  } catch (error) {
    await ctx.ui.dialog.alert({
      title: "创建会话失败",
      message: String(error instanceof Error ? error.message : error),
    })
    return
  }
  await updateState(ctx, (draft) => {
    draft.lastDir = { ...(draft.lastDir ?? {}), [device.id]: dir }
  })
  if (await isConnectedServer(ctx, session.id)) {
    ctx.ui.router.navigate({ type: "session", sessionID: session.id })
    ctx.ui.toast.show({ title: "已打开会话", message: `${device.name} · ${dir}`, variant: "success" })
    return
  }
  await updateState(ctx, (draft) => {
    const pending = (draft.pending ?? []).filter((p: any) => p.sessionID !== session.id)
    pending.push({
      sessionID: session.id,
      device: device.id,
      deviceName: device.name,
      dir,
      ts: Date.now(),
    })
    draft.pending = pending.slice(-10)
  })
  await ctx.ui.dialog.alert({
    title: `已在 ${device.name} 创建会话`,
    message: [
      `目录：${dir}`,
      "",
      `打开方式：${device.openHint ?? "打开该设备的 OpenCode 界面"}`,
      "打开后几秒内会自动进入这个会话。",
    ].join("\n"),
  })
}

async function runRemoteFlow(ctx: Ctx) {
  const device = await pickDevice(ctx, "选择远程设备（将在该设备上新建会话）")
  if (!device) return
  const state = await readState(ctx)
  const savedLast = state.lastDir?.[device.id]
  const last = savedLast ?? device.defaultDir
  const options: any[] = []
  if (last) options.push({ title: last, value: last, category: savedLast ? "最近使用" : "默认" })
  if (device.defaultDir && device.defaultDir !== last) {
    options.push({ title: device.defaultDir, value: device.defaultDir, category: "默认" })
  }
  options.push({ title: "✏️ 输入其他路径…", value: "__input__", category: "其他" })
  const choice = await ctx.ui.dialog.select({ title: `${device.name} · 选择目录`, options })
  if (choice === undefined) return
  let dir = String(choice)
  if (dir === "__input__") {
    const input = await ctx.ui.dialog.prompt({
      title: `在 ${device.name} 上输入目录路径`,
      placeholder: promptExample(device),
    })
    if (input === undefined) return
    dir = String(input).trim()
  }
  if (!dir) return
  await createAndOpen(ctx, device, dir)
}

async function runDeviceFlow(ctx: Ctx) {
  if (!(await requireConfig(ctx))) return
  const probes = await Promise.allSettled(
    DEVICES.map(async (device: Device) => {
      const status = await ping(device)
      if (!status.ok) return { device, ok: false }
      const projects = visibleProjects(device, await listProjects(device)).slice(0, 40)
      const checks = await Promise.allSettled(
        projects.map(async (project: any) => ((await isDir(device, project.canonical)) ? project : null)),
      )
      const alive = checks.filter((c: any) => c.status === "fulfilled" && !!c.value).map((c: any) => c.value)
      return { device, ok: true, projects: alive }
    }),
  )
  const options: any[] = []
  for (const probe of probes) {
    if (probe.status !== "fulfilled" || !probe.value.ok) continue
    const { device, projects } = probe.value
    const sorted = [...projects].sort(
      (a: any, b: any) => (b.time?.active ?? 0) - (a.time?.active ?? 0),
    )
    for (const project of sorted) {
      options.push({
        title: baseName(project.canonical),
        value: JSON.stringify({ device: device.id, dir: project.canonical }),
        description: project.canonical,
        category: device.name,
      })
    }
  }
  if (options.length === 0) {
    await ctx.ui.dialog.alert({ title: "没有可用项目", message: "设备离线，或项目目录均已不存在。" })
    return
  }
  const chosen = await ctx.ui.dialog.select({
    title: "选择项目（在该目录打开新会话）",
    options,
    search: (query: string, items: any[]) => {
      const q = query.toLowerCase()
      if (!q) return items
      return items.filter(
        (item) =>
          String(item.title).toLowerCase().includes(q) ||
          String(item.description ?? "").toLowerCase().includes(q),
      )
    },
  })
  if (chosen === undefined) return
  const target = JSON.parse(String(chosen))
  const device = DEVICES.find((d: Device) => d.id === target.device)
  if (!device) return
  await createAndOpen(ctx, device, target.dir)
}

async function runOpenFlow(ctx: Ctx, input?: string) {
  if (!(await requireConfig(ctx))) return
  const arg = String(input ?? "").trim()
  let device: Device | undefined
  if (arg) {
    const q = arg.toLowerCase()
    device = DEVICES.find(
      (d: Device) =>
        d.id === arg || String(d.id).toLowerCase() === q || String(d.name).toLowerCase().includes(q),
    )
    if (!device) {
      await ctx.ui.dialog.alert({
        title: "找不到设备",
        message: `没有叫「${arg}」的设备。已配置：${DEVICES.map((d: Device) => d.id).join("、")}`,
      })
      return
    }
  } else {
    device = await pickDevice(ctx, "选择设备（按默认/最近目录打开）")
  }
  if (!device) return
  const state = await readState(ctx)
  let dir = state.lastDir?.[device.id] ?? device.defaultDir
  if (!dir) {
    const typed = await ctx.ui.dialog.prompt({
      title: `在 ${device.name} 上输入目录路径`,
      placeholder: promptExample(device),
    })
    if (typed === undefined) return
    dir = String(typed).trim()
    if (!dir) return
  }
  await createAndOpen(ctx, device, String(dir))
}

async function resumePending(ctx: Ctx) {
  const state = await readState(ctx)
  const pending = [...(state.pending ?? [])].reverse()
  for (const item of pending) {
    if (Date.now() - (item.ts ?? 0) > 7 * 24 * 60 * 60 * 1000) continue
    if (!(await isConnectedServer(ctx, item.sessionID))) continue
    await updateState(ctx, (draft) => {
      draft.pending = (draft.pending ?? []).filter((p: any) => p.sessionID !== item.sessionID)
    })
    ctx.ui.router.navigate({ type: "session", sessionID: item.sessionID })
    ctx.ui.toast.show({
      title: "已自动打开会话",
      message: `${item.deviceName} · ${item.dir}`,
      variant: "success",
    })
    return
  }
}

export default Plugin.define({
  id: "opencode-one-client",
  setup(ctx: any) {
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-one-client.remote",
          title: "选择远程设备并新建会话",
          group: "设备",
          palette: true,
          slash: { name: "remote" },
          run: async () => {
            try {
              await runRemoteFlow(ctx)
            } catch (error) {
              ctx.ui.toast.show({
                title: "出错了",
                message: String(error instanceof Error ? error.message : error),
                variant: "error",
              })
            }
          },
        },
        {
          id: "opencode-one-client.device",
          title: "选择设备上的项目并打开",
          group: "设备",
          palette: true,
          slash: { name: "device" },
          run: async () => {
            try {
              await runDeviceFlow(ctx)
            } catch (error) {
              ctx.ui.toast.show({
                title: "出错了",
                message: String(error instanceof Error ? error.message : error),
                variant: "error",
              })
            }
          },
        },
        {
          id: "opencode-one-client.open",
          title: "打开设备（按默认/最近目录）",
          group: "设备",
          palette: true,
          slash: { name: "open", arguments: true },
          run: async (input: any) => {
            try {
              await runOpenFlow(ctx, typeof input === "string" ? input : undefined)
            } catch (error) {
              ctx.ui.toast.show({
                title: "出错了",
                message: String(error instanceof Error ? error.message : error),
                variant: "error",
              })
            }
          },
        },
      ],
    }))
    setTimeout(() => {
      void resumePending(ctx).catch(() => {})
    }, 1500)
    return () => {}
  },
})
