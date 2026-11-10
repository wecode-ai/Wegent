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

脚本同样对齐 macOS 的开发实例模型：按 worktree 推导稳定身份和标题，为
Electron 提供隔离的应用标识与用户数据目录，并为源码 Core DSH 插件生成组件
资源。重命名可执行文件 bundle 是 macOS 特有实现；Windows 开发标题由
Electron 进程身份承载。

不可变的 Runtime 归档和 Executor 构建缓存默认放在
`%LOCALAPPDATA%\wegent\`（可用 `WEWORK_DEV_CACHE_ROOT`、
`WEGENT_CARGO_TARGET_ROOT` 覆盖）。当系统盘空间不足且尚无可用缓存时，Cargo
target 会按 `D:` 到 `H:` 的顺序回退。可变且按 worktree 隔离的 materialized
runtime 仍保留在当前检出的 `wework/node_modules/.cache`，避免不同 worktree
共享活跃文件。首次准备较慢，之后为增量。可用
`-- --executor-isolation` 使用临时 Executor Home，或用 `WEWORK_DRY_RUN=1`
只打印启动配置。若下载卡住，先设置 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量。

## 构建

```powershell
pnpm --dir wework/electron build:release
```

NSIS 安装器写入
`wework/electron/release-installer/WeWork_<version>_windows_x64-setup.exe`。图标、
插件、运行时描述和 sidecar 统一来自 `wework/resources/`，由
`wework/electron/scripts/prepare-package-assets.mjs` 复制到应用资源目录。

安装器使用 Electron Builder 的标准 NSIS 安装流程，不再处理旧 updater 的 `/P`
参数或旧安装注册表迁移。

### 应用本地 VC++ 运行库

Windows 打包需要 Visual Studio C++ Build Tools 的 x64 可再发行文件。
构建脚本优先读取 `VCToolsRedistDir`，否则通过微软的 `vswhere.exe` 定位已安装
工具链的 `VC\Redist\MSVC`。非标准工具链或交叉打包可显式设置
`WEWORK_VC_REDIST_DIR`，指向官方的 `x64\Microsoft.VC*.CRT` 目录。
不要从系统目录、第三方 DLL 网站或其他应用复制运行库。

打包按 Executor 和原生启动器的 PE 普通/延迟导入表收集 VC DLL 及其传递依赖，
只将必要的 x64 DLL 放到各自 EXE 旁边，不运行 `vc_redist`、不写 `System32`。
因此最终用户不需要额外安装 Node.js 或 VC++ 运行库，也不会因为部署这些 DLL
而被要求重启。缺失 DLL 或架构不符会直接阻止打包。

Windows 的 `bin` 原生工具目录（Executor、DWS 和本地 VC DLL）作为一个完整
Executor 组件进行内容校验、发布、激活和回滚。Host-only 更新同样包含启动前
必须可用的 `bin` 目录和启动器 DLL。打包检查校验运行库哈希，并执行真实的
迁移锁协议。VC DLL 的安全更新由应用发布负责，不能依赖 Windows Update
替应用更新这些本地副本。

干净 Windows 沙箱验收应覆盖：不安装全局 VC++ 运行库，首次安装并启动应用，
完成一次云端模型文字聊天，再验证组件升级和回滚。单元测试或已有全局运行库的
构建机通过不能替代该验收。

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
18 个 Core 分片；路径分类只选中部分 checkpoint 时，两个平台仍运行完全相同的已选
分片。Windows 路径、盘符、UNC 路径、命名管道和 `.exe` sidecar 行为必须由这个
Windows job 验证，其他平台的通过结果不能替代它。

Windows CI 缓存 pnpm store，每次安装时重建依赖链接，不恢复 `node_modules`
目录链接。E2E 使用随构建产物打包的 Socket.IO 客户端。远程设备 HOME 查询会将
Git Bash 的路径转换为 Windows 原生路径；文件预览断言使用界面规范化的路径。
技能目录在 Windows 使用绝对目标的 junction，Unix 使用相对符号链接。
生成图片的工作区引用移除 Rust canonicalize 产生的 Windows 扩展路径前缀，
避免 renderer 将其误解析为 POSIX 路径。
Windows 工作区克隆会启用并保存 `core.longpaths=true`，确保 Git 模板文件及后续
操作支持长路径。Core DSH 和智能工作台插件安装使用各自 DSH Home 内的
`pnpm-store`，避免跨盘默认 store 指向管理员创建的只读 SQLite 缓存。

普通用户 CI 进程的 stdout/stderr 会实时转发，并独立保存到
`.ci-artifacts/windows-standard-user/`，避免其他运行时文件被锁定时丢失进程日志。
新桌面窗口的就绪握手使用已有的 180 秒启动预算；缺少就绪事件会明确失败并保存
诊断，而不是一直等到整个 CI job 被终止。
抽屉 E2E 分别通过 Electron 的媒体偏好控制验证正常动画与减少动态效果，结束后恢复
系统偏好。固定环境面板场景会显式建立足够宽的窗口，避免误测窄窗口的浮动面板。

正式安装器、代码签名和 Electron YAML 更新清单由
`.github/workflows/wework-app.yml` 在 `windows-latest` 上生成。

## 常见问题

- **Electron 找不到 Executor**：确认打包前成功执行 sidecar 准备步骤，并检查产物
  的 `resources/bin/`。
- **renderer 无法连接主进程**：检查 preload 是否已构建，并确认
  `wework/electron/dist/` 与 renderer 产物来自同一次构建。
- **路径或命令在 Windows 上失败**：使用 Node 路径 API 和参数数组，不要拼接
  POSIX shell 命令或硬编码 `/`。
