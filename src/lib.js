// oc-devices 插件的纯逻辑层（与 TUI API 无关），可用 node 直接运行测试。

export const AUTH_USER = "opencode";

export function authHeader(device) {
  return "Basic " + btoa(`${AUTH_USER}:${device.password}`);
}

export async function http(device, path, opts = {}) {
  const { method = "GET", body, headers = {}, timeoutMs = 8000 } = opts;
  try {
    const res = await fetch(device.url + path, {
      method,
      headers: { authorization: authHeader(device), ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, error: String(error) };
  }
}

export async function ping(device, timeoutMs = 2500) {
  const res = await http(device, "/api/info", { timeoutMs });
  const info = res.json;
  return {
    ok: res.status === 200,
    status: res.status,
    version: info?.version,
    urls: info?.urls ?? [],
  };
}

// 目录是否存在：通过 fs/list 验证（location 接口对文件也返回 200，不能用于此判断）
export async function isDir(device, dir, timeoutMs = 8000) {
  const res = await http(device, `/api/fs/list?location%5Bdirectory%5D=${encodeURIComponent(dir)}`, { timeoutMs });
  return res.status === 200;
}

export async function ptyRun(device, command, args, timeoutMs = 8000) {
  const res = await http(device, "/api/pty", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command,
      args,
      cwd: device.platform === "windows" ? "C:\\" : "/",
      title: "oc-dir-helper",
    }),
    timeoutMs,
  });
  const id = res.json?.data?.id ?? res.json?.id;
  return res.ok && id ? id : undefined;
}

export function ptyDelete(device, ptyID) {
  return http(device, `/api/pty/${ptyID}`, { method: "DELETE", timeoutMs: 4000 });
}

// 在设备上创建目录（不存在才需要）：Windows 走 cmd /c mkdir，POSIX 走 mkdir -p。
// 注意：参数按“一个路径一个 argv”传递，路径含空格由运行时自动加引号（已验证）。
export async function ensureDir(device, dir, { waitMs = 8000 } = {}) {
  const command = device.platform === "windows" ? "cmd" : "mkdir";
  const args = device.platform === "windows" ? ["/c", "mkdir", dir] : ["-p", dir];
  const ptyID = await ptyRun(device, command, args);
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    await sleep(400);
    if (await isDir(device, dir, 3000)) {
      if (ptyID) void ptyDelete(device, ptyID);
      return true;
    }
  }
  if (ptyID) void ptyDelete(device, ptyID);
  return false;
}

export async function createSession(device, dir, title, timeoutMs = 15000) {
  const res = await http(device, "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, location: { directory: dir } }),
    timeoutMs,
  });
  const data = res.json?.data ?? res.json;
  if (!res.ok || !data?.id) {
    throw new Error(`创建会话失败 (HTTP ${res.status}): ${String(res.text ?? res.error ?? "").slice(0, 300)}`);
  }
  return data;
}

export async function listProjects(device, timeoutMs = 8000) {
  const res = await http(device, "/api/project", { timeoutMs });
  const arr = res.json?.data ?? res.json;
  return Array.isArray(arr) ? arr : [];
}

export function visibleProjects(device, projects) {
  const hideExact = device.hideExact ?? [];
  const hidePrefix = device.hidePrefix ?? [];
  return projects.filter((project) => {
    const dir = project.canonical ?? project.directory;
    if (!dir) return false;
    if (hideExact.includes(dir)) return false;
    if (hidePrefix.some((prefix) => dir.startsWith(prefix))) return false;
    return true;
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function baseName(dir) {
  const trimmed = String(dir).replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return trimmed.slice(idx + 1) || trimmed || String(dir);
}
