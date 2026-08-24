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

该命令使用 `wework/electron` 主进程加载 Wework renderer。Electron 通过子进程
stdin/stdout 与 Executor sidecar 交换 JSONL，不依赖 Unix Domain Socket 或固定
TCP 端口。

## 构建

```powershell
cd wework
pnpm run prepare:codex --materialize
pnpm run prepare:dws
pnpm run build:windows
```

产物写入 `wework/electron/release/WeWork-win32-<arch>/`。图标、插件、运行时描述和
sidecar 统一来自 `wework/resources/`，由
`wework/electron/scripts/prepare-package-assets.mjs` 复制到应用资源目录。

## 验证

```powershell
pnpm --filter wework typecheck
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test
pnpm --filter wework build:windows
```

正式跨平台归档由 `.github/workflows/wework-app.yml` 在 `windows-latest` 上生成。

## 常见问题

- **Electron 找不到 Executor**：确认打包前成功执行 sidecar 准备步骤，并检查产物
  的 `resources/bin/`。
- **renderer 无法连接主进程**：检查 preload 是否已构建，并确认
  `wework/electron/dist/` 与 renderer 产物来自同一次构建。
- **路径或命令在 Windows 上失败**：使用 Node 路径 API 和参数数组，不要拼接
  POSIX shell 命令或硬编码 `/`。
