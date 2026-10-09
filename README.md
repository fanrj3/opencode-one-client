# opencode-one-client

> A tiny companion for OpenCode users with multiple machines.

在 OpenCode 里管理多台设备（本机 + 各远程机器）：

- **命令行工具 `ocd`**（终端入口）
  - `ocd add` —— 添加一台设备（联网验证；支持「邀请」一键添加）
  - `ocd open <设备>` —— 从终端直接连上该设备（等价于 `opencode --server http://…`）
  - `ocd list` —— 列出设备及在线状态
  - `ocd remove <设备>` —— 移除设备
  - `ocd invite` —— 在**设备端**运行：检测本机服务并输出一行「邀请命令」，粘贴到主机即完成添加
- **TUI 斜杠命令**（安装插件后可用；也出现在 `Ctrl+P` 命令面板）
  - `/remote` —— 查看所有设备（含在线状态）→ 选一台 → 选择 / 输入 / 创建目录 → 在该设备上**新建并打开会话**
  - `/device` —— 选择某台设备上的**既有项目**（按设备分组、按最近活跃排序）→ 在该目录打开新会话
  - `/open <设备>` —— 直接在指定设备上按「最近使用 / 默认目录」打开

> 小提示：`/open` 与系统内置的「Open session or project」重名——带参数时（`/open mac`）走本插件；想用插件的不带参数选择器请改用 `/remote`。

## 快速开始

### 1. 安装

```bash
# 命令行工具
npm install -g opencode-one-client
#（不想全局装：下面所有 ocd 命令都可写成 npx opencode-one-client …）

# TUI 插件
opencode plugin add opencode-one-client
```

TUI 命令需要通过 `cli.json` 注册（OpenCode 文档要求；这样连远程服务器时插件也保持生效）：

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-one-client"]
}
```

### 2. 添加设备

**第一台：本机**

```bash
ocd add --local      # 自动读取本机 OpenCode 服务的密码并写入配置
ocd list             # 应该能看到它，且显示「在线」
```

**更多设备（每台一次）** —— 在**那台设备上**运行（需要 Node.js）：

```bash
npx opencode-one-client invite
```

它会自动检测该设备的服务地址与密码，输出一行命令；**复制到你平时用的主机上粘贴运行**：

```bash
ocd add my-server --url http://my-server.tailnet.ts.net:49374 --password '…' --platform posix
```

完成后 `ocd list` 验证；之后终端里 `ocd open my-server` 即可直达该设备。

> 设备端前提：那台机器上要有 OpenCode 服务在跑（桌面版 / `opencode serve` / `opencode service start`），且服务对网络可达——`invite` 会自动检查并提示修复（绑定地址、防火墙等）。

**手动添加也可以**（知道地址和密码时）：

```bash
ocd add my-server --url my-server:49374
# 缺 --password 时会交互输入密码（输错会当场被拦下）
```

### 3. 在 TUI 里用

装好插件后，任意 OpenCode 界面里：

- `/remote` → 选设备 → 选 / 输入 / 新建目录 → 会话开好并在该设备打开
- `/device` → 三台设备的既有项目按设备分组列出 → 直接打开
- `/open <设备>` → 快通道，用「最近目录 / 默认目录」直接开

跨设备时：在 A 设备给 B 设备创建的会话，打开 B 设备的界面会在几秒内**自动跳转**过去。

## 配置（进阶）

设备清单保存在 `~/.config/opencode/opencode-one-client.json`（设置 `XDG_CONFIG_HOME` 时前缀替换为该目录）。除 `ocd add` 外也可以手写：

```json
{
  "devices": [
    {
      "id": "my-server",
      "name": "我的服务器",
      "platform": "posix",
      "url": "http://my-server.tailnet.ts.net:49374",
      "password": "服务密码",
      "defaultDir": "/home/me",
      "cwd": "~/.local/state/opencode-one-client/launch/my-server",
      "openHint": "在终端运行 ocd open my-server 打开它的界面",
      "promptExample": "例如 /home/me/code/new-project",
      "testDir": "/home/me/__oc_selftest__",
      "hideExact": ["/opt"],
      "hidePrefix": ["/tmp"]
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` / `name` | 标识（`ocd open` 和 `/open` 的参数用它）与显示名 |
| `platform` | `posix` 或 `windows`；省略时按 `defaultDir` 自动判断 |
| `url` | OpenCode 服务地址（含端口） |
| `password` | 服务密码（HTTP Basic 认证，用户名固定 `opencode`） |
| `defaultDir` | 默认目录（`/remote` 的「默认」项、`/open` 的兜底目录） |
| `cwd` | 可选：`ocd open` 在此目录启动界面（不存在会自动创建）。多设备连不同服务器时，给每台设不同的 `cwd` 可隔离界面标签状态（见下） |
| `openHint` | 跨设备创建会话后提示的「打开方式」文案 |
| `promptExample` | 输入路径时的占位示例 |
| `testDir` | 自检脚本使用的临时目录 |
| `hideExact` / `hidePrefix` | 从项目列表隐藏的目录（完全匹配 / 前缀匹配） |

## 工作原理

- 每台「设备」就是一台运行着 OpenCode 后台服务的机器：`opencode serve`、桌面版或 `opencode service` 都行
- 插件与 `ocd` 通过 OpenCode 的 HTTP API 与该设备交互（认证用户名固定 `opencode`）
- `ocd invite` 读取设备端的服务配置（`~/.config/opencode/service.json`）自动生成添加命令
- 目录不存在时，会询问后通过设备上的命令通道创建
- 「待打开」记录与「最近使用目录」保存在 `~/.config/opencode/opencode-one-client.state.json`（桌面版与各终端 TUI 互通）
- 跨设备：在 A 设备给 B 设备创建会话后，打开 B 设备的界面会在几秒内**自动跳转**到该会话

### 多设备小贴士：界面标签互不串台

OpenCode 客户端把「已打开的标签页」按**启动目录**记录在同一个状态文件里，而不管连的是哪台服务器。于是从同一个目录启动多个连不同服务器的界面时，各自的标签栏里会看到别的设备的标签，点击会报 `Session not found`（随后自动清理恢复）。

规避方法：给每台设备配置**不同**的 `cwd`（见上表），让每个界面从独立目录启动。`ocd add` 添加的新设备会自动配置 `~/.local/state/opencode-one-client/launch/<设备id>`。

## 开发 / 自检

```bash
node selftest.mjs            # 全部设备：建临时目录 → 建会话 → 删除
node selftest.mjs my-server  # 指定设备
```

源码结构：`src/`（`tui.ts` 插件主体、`devices.js` 配置加载、`lib.js` HTTP 封装）、`bin/ocd.js` 命令行工具。

## License

MIT
