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

1. **本地 IPC 使用标准输入输出**：Tauri 通过子进程 stdin/stdout 与 Executor sidecar 交换 JSONL 消息，不依赖 Unix Domain Socket、TCP 端口或地址文件，因此各平台使用同一条父子进程通道。
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

- Tauri 启动 Executor sidecar，并通过 stdin 发送 JSONL 请求。
- Executor 只在 stdout 输出 JSONL 响应和事件，普通诊断日志写入 stderr。
- stdin 关闭或子进程退出时，本地 IPC 生命周期随即结束；不需要端口发现或重连。

---

## 已知限制

- **本地终端默认使用 PowerShell**：不再调用 `/bin/zsh`。
- **Executor 生命周期绑定桌面主进程**：完整退出 Wework 会关闭 stdin 并终止其管理的 Executor；不支持在新的 Wework 主进程中重新附着旧 Executor。
- **部分后端/沙箱路径仍为 Unix 语义**：例如 Docker socket 路径、`/home/user`、`/workspace` 等仅在远端 Linux/macOS Executor Manager 中使用，不进入 Windows 桌面安装包路径。

---

## 故障排查

- **`cargo xwin` 找不到 C 编译器**：确保 LLVM 已安装且 `clang` 在 `PATH` 中。
- **Tauri 找不到 sidecar**：确认 `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe` 存在。
- **NSIS 构建失败**：确认已安装 NSIS（Windows 或 macOS 均可）。
- **运行时无法连接 Executor**：检查 sidecar 是否成功启动，并确认 Executor 没有向 stdout 输出非协议文本；诊断日志应写入 stderr 或 Executor 日志文件。
- **发送消息时提示 "program not found"**：本地 Executor sidecar 可能缺失或已过期。请使用 `pnpm run build:windows:sidecar`（在 macOS 上交叉编译）重新构建，或在 Windows 本机执行 `cargo build --release --target x86_64-pc-windows-msvc` 后将 `wegent-executor.exe` 复制到 `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe`。
- **本地已安装 Codex 提示 "program not found"**：在 Windows 上解析 `codex` 时会自动尝试 `codex.exe`、`codex.cmd`、`codex.bat` 等可执行扩展名；同时会兜底搜索 `%APPDATA%\npm` 和 `~/.cargo/bin` 等常见用户目录（因为 GUI 启动的进程可能无法继承 shell 的 `PATH`）。如果 Codex 安装在其他位置，可设置完整路径的环境变量：`$env:CODEX_BINARY_PATH = "C:\Path\To\codex.exe"`。
