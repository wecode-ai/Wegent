---
sidebar_position: 27
---

# Wework Windows 开发与构建

Wework Windows 桌面版使用 Electron，并与 macOS、Linux 共用同一套 renderer、
Electron 主进程和 Executor sidecar 协议。

## 环境准备

安装 Node.js、pnpm、Git，以及构建 Executor 所需的 Rust 工具链。然后安装依赖：

```powershell
pnpm install --frozen-lockfile
pnpm --dir wework/electron install --frozen-lockfile
```

## 开发

```powershell
pnpm --filter wework dev:windows
```

该命令由 `wework/scripts/dev-windows-app.ps1` 驱动（对应 macOS 的
`dev-mac-app.sh`）：自动准备 Electron 资源（图标、内置插件）、Codex/DWS
二进制、Node 运行时与 Harness 运行时（含核心 DSH），编译 Executor，然后启动
`wework/electron` 主进程加载 Wework renderer。Electron 通过子进程 stdin/stdout
与 Executor sidecar 交换 JSONL，不依赖 Unix Domain Socket 或固定 TCP 端口。

开发模式下，脚本会先构建 renderer 产物（`wework/dsh/app-wework/web`）并启动
Vite watch 构建，再通过 `WEWORK_APP_WEB_ROOT`/`WEWORK_APP_HOT_RELOAD` 让
运行的桌面应用直接服务最新构建并在产物变化时自动刷新（与 `dev-mac-app.sh`
一致）。因此切换分支或修改 renderer 源码后，无需手动同步打包插件产物即可
生效。

运行时与 Executor 构建缓存默认放在 `%LOCALAPPDATA%\wegent\`（可用
`WEWORK_DEV_CACHE_ROOT`、`WEGENT_CARGO_TARGET_ROOT` 覆盖），首次准备较慢，
之后为增量。可用 `-- --executor-isolation` 使用临时 Executor Home，或用
`WEWORK_DRY_RUN=1` 只打印启动配置。若下载卡住，先设置
`HTTP_PROXY`/`HTTPS_PROXY` 环境变量。

## 构建

```powershell
pnpm --dir wework/electron build:release
```

NSIS 安装器写入
`wework/electron/release-installer/WeWork_<version>_windows_x64-setup.exe`。图标、
插件、运行时描述和 sidecar 统一来自 `wework/resources/`，由
`wework/electron/scripts/prepare-package-assets.mjs` 复制到应用资源目录。

该安装器同时承担旧 Tauri 版本到 Electron 的迁移：它兼容 Tauri updater 传入的
`/P` 参数，读取旧版 `Software\you\WeWork` 注册表项，并沿用
`%LOCALAPPDATA%\WeWork` 安装目录。旧版点击“升级”后会先安装 Electron，再按同一
`WeWork.exe` 路径重启，因此不会产生第二套安装目录，且不会删除用户数据。
Electron 启动的 Executor 继续直接使用用户目录下原有的 `.wework`，不执行目录
复制或数据迁移。

## 验证

```powershell
pnpm --filter wework typecheck
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test
pnpm --dir wework/electron build:release
```

桌面 E2E 使用的原生测试应用可通过统一入口构建：

```powershell
$env:CI = "true"
pnpm --filter wework ai:verify:electron:build
```

该命令会准备 Electron、Codex、DWS 和 Executor sidecar，并在当前操作系统生成原生
应用；Windows 产物为
`wework/electron/release/WeWork-win32-x64/WeWork.exe`，不能用 Linux 或 macOS
产物替代。

`.github/workflows/wework-e2e.yml` 会在 `windows-latest` 上构建该原生应用，并让
Windows Desktop Core E2E 复用 Linux 的同一份 Core 分片矩阵。完整回归会运行全部
17 个 Core 分片；路径分类只选中部分 checkpoint 时，两个平台仍运行完全相同的已选
分片。Windows 路径、盘符、UNC 路径、命名管道和 `.exe` sidecar 行为必须由这个
Windows job 验证，其他平台的通过结果不能替代它。

正式安装器、代码签名、Electron YAML 更新清单和旧 Tauri JSON/签名桥接清单由
`.github/workflows/wework-app.yml` 在 `windows-latest` 上生成。

## 常见问题

- **Electron 找不到 Executor**：确认打包前成功执行 sidecar 准备步骤，并检查产物
  的 `resources/bin/`。
- **renderer 无法连接主进程**：检查 preload 是否已构建，并确认
  `wework/electron/dist/` 与 renderer 产物来自同一次构建。
- **路径或命令在 Windows 上失败**：使用 Node 路径 API 和参数数组，不要拼接
  POSIX shell 命令或硬编码 `/`。
