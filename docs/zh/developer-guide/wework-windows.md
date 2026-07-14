---
sidebar_position: 45
---

# Wework Windows 桌面端构建指南

本文档介绍如何在 Windows 上构建和运行 Wework 桌面端（`wework`），以及如何从 macOS 交叉编译 Windows 安装包。

---

## 前置要求

### 在 Windows 本机构建

- **Windows 10/11**
- **Rust 1.77+** 并安装目标 `x86_64-pc-windows-msvc`
- **Node.js 20+** 和 **pnpm**
- **Visual Studio Build Tools**（提供 MSVC 工具链）
- **Git**

### 在 macOS 上交叉编译 Windows 安装包

- **macOS**（Apple Silicon 或 Intel）
- **Rust 1.77+**
- **cargo-xwin**: `cargo install cargo-xwin`
- **LLVM**（用于 `clang`）：`brew install llvm`，并确保 `/opt/homebrew/opt/llvm/bin` 在 `PATH` 中
- **NSIS**（用于生成安装程序）：`brew install nsis`
- **Node.js 20+** 和 **pnpm**

---

## 项目变更概要

为支持 Windows，主要做了以下调整：

1. **本地 IPC 从 Unix Domain Socket 改为 TCP 回环地址**：Executor sidecar 绑定到 `127.0.0.1:0`，OS 自动分配端口，并将实际地址写入 `~/.wegent-executor/app-ipc.addr`。Tauri 前端通过读取该文件发现端口。
2. **统一使用 `dirs::home_dir()` 解析用户目录**：在 Windows 上回退到 `USERPROFILE`，不再依赖 `HOME` 环境变量。
3. **文件权限操作仅保留在 Unix 平台**：Windows 忽略 `chmod` / `set_mode`。
4. **本地终端默认使用 PowerShell**：在 Windows 上优先尝试 `pwsh.exe`，其次 `powershell.exe`。
5. **新增 Windows 构建脚本和 Tauri 配置**：`wework/scripts/build-windows-app.sh` 与 `wework/src-tauri/tauri.windows.conf.json`。

---

## Windows 本机开发

### 1. 安装依赖

```powershell
# 安装 Rust 目标
rustup target add x86_64-pc-windows-msvc

# 安装 pnpm
npm install -g pnpm

# 安装前端依赖
pnpm install
```

### 2. 构建本地 Executor sidecar

```powershell
cd executor
cargo build --release --target x86_64-pc-windows-msvc
```

将生成的二进制文件复制到 Tauri 期望的位置：

```powershell
$target = "x86_64-pc-windows-msvc"
cp "executor\target\$target\release\wegent-executor.exe" "wework\src-tauri\binaries\wegent-executor-$target.exe"
```

也可以在 macOS 上通过仓库内的便捷命令只交叉编译 sidecar（比完整打包更快）：

```bash
cd wework
pnpm run build:windows:sidecar
```

### 3. 准备 Codex 二进制

```powershell
cd wework
$env:WEWORK_CODEX_TARGET = "x86_64-pc-windows-msvc"
pnpm run prepare:codex
```

### 4. 启动开发模式

```powershell
pnpm exec tauri dev --target x86_64-pc-windows-msvc
```

---

## 从 macOS 交叉编译 Windows 安装包

使用仓库内的构建脚本：

```bash
bash wework/scripts/build-windows-app.sh
```

脚本会：

1. 使用 `cargo xwin build` 为 `x86_64-pc-windows-msvc` 构建 Executor sidecar。
2. 将 `wegent-executor.exe` 复制到 `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe`。
3. 准备 Windows 版 Codex 二进制。
4. 使用 `cargo-xwin` 构建 Tauri 并生成 NSIS 安装包。

安装包默认输出路径：

```
wework/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

### 使用仓库内的便捷命令

```bash
cd wework
pnpm run build:windows
```

该命令等价于调用 `bash scripts/build-windows-app.sh`。

---

## 运行时行为

- Executor sidecar 启动后会在 `~/.wegent-executor/app-ipc.addr` 写入监听的 TCP 地址（如 `127.0.0.1:54321`）。
- Tauri 前端读取该文件并建立 TCP 连接。
- 如果端口冲突，Executor 会绑定到 OS 分配的可用端口；Tauri 通过地址文件动态发现。

---

## 已知限制

- **本地终端默认使用 PowerShell**：不再调用 `/bin/zsh`。
- **IPC 不再使用 Unix Domain Socket**：同一台机器上的其他本地进程理论上可以连接到 `127.0.0.1` 端口；生产环境建议仅在可信本地环境使用。
- **进程孤儿清理**：Windows 暂不支持像 Unix 那样通过 `/proc` 枚举并清理遗留 Executor 进程；依赖 Tauri 应用生命周期关闭 sidecar。
- **部分后端/沙箱路径仍为 Unix 语义**：例如 Docker socket 路径、`/home/user`、`/workspace` 等仅在远端 Linux/macOS Executor Manager 中使用，不进入 Windows 桌面安装包路径。

---

## 故障排查

- **`cargo xwin` 找不到 C 编译器**：确保 LLVM 已安装且 `clang` 在 `PATH` 中。
- **Tauri 找不到 sidecar**：确认 `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe` 存在。
- **NSIS 构建失败**：确认已安装 NSIS（Windows 或 macOS 均可）。
- **运行时无法连接 Executor**：检查 `~/.wegent-executor/app-ipc.addr` 是否存在且可被读取，以及是否有防火墙拦截 `127.0.0.1` 回环地址。
- **发送消息时提示 "program not found"**：本地 Executor sidecar 可能缺失或已过期。请使用 `pnpm run build:windows:sidecar`（在 macOS 上交叉编译）重新构建，或在 Windows 本机执行 `cargo build --release --target x86_64-pc-windows-msvc` 后将 `wegent-executor.exe` 复制到 `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe`。
- **本地已安装 Codex 提示 "program not found"**：在 Windows 上解析 `codex` 时会自动尝试 `codex.exe`、`codex.cmd`、`codex.bat` 等可执行扩展名；同时会兜底搜索 `%APPDATA%\npm` 和 `~/.cargo/bin` 等常见用户目录（因为 GUI 启动的进程可能无法继承 shell 的 `PATH`）。如果 Codex 安装在其他位置，可设置完整路径的环境变量：`$env:CODEX_BINARY_PATH = "C:\Path\To\codex.exe"`。
