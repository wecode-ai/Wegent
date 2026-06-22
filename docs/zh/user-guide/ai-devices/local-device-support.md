---
sidebar_position: 10
---

# 在本地设备上执行AI任务

本地设备支持允许您使用个人电脑（Mac、Linux 或 Windows）作为任务执行器，让 AI 任务直接在本地机器上运行。

<img src="https://github.com/user-attachments/assets/ead0cc30-b3a4-4eb6-a6dd-77ffcbd72238" width="100%" alt="AI Device Demo"/>

---

## 📋 目录

- [概述](#-概述)
- [设备注册](#-设备注册)
- [使用本地设备](#-使用本地设备)
- [设备管理](#-设备管理)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 概述

### 什么是本地设备支持？

本地设备支持允许您的个人电脑作为 Wegent 的任务执行器。任务不再在云端基础设施上运行，而是直接在您的本地机器上执行，并提供实时流式反馈。

### 核心价值

| 优势 | 描述 |
|------|------|
| **更低延迟** | 本地直接执行，无需网络传输延迟 |
| **数据隐私** | 您的代码和数据永远不会离开本地机器 |
| **环境控制** | 使用本地安装的工具、依赖和配置 |
| **成本节约** | 减少云端执行资源消耗 |
| **自定义设置** | 访问本地凭证、自定义工具和专业软件 |

---

## 📲 设备注册

### 前置条件

在注册本地设备之前，请确保您具备：

- [ ] 有效凭证的 Wegent 账号
- [ ] 在您的机器上安装了 Wegent Executor
- [ ] 能够连接到 Wegent 后端的网络
- [ ] 已配置 Claude Code SDK（用于 ClaudeCode shell 类型）

### 安装 Wegent Executor

#### 一键安装（推荐）

**macOS / Linux：**
```bash
curl -fsSL https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh | bash
```

**Windows (PowerShell)：**
```powershell
irm https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1 | iex
```

安装脚本将会：
- 检查并安装 Node.js 18+（Claude Code 运行所需）
- 安装或升级 Claude Code SDK
- 下载适合您平台的二进制文件
- 将二进制文件添加到系统 PATH

#### Linux AMD64 无内置 Claude 版本

GitHub Release 同时提供 `wegent-executor-linux-amd64-no-claude`。这个二进制不会把 Claude CLI 打包进 executor，适用于以下场景：

- 云设备或本地设备 Docker 镜像已经通过 npm、基础镜像或其他方式安装 `claude` 命令
- 希望减小 executor 二进制体积
- 需要由镜像或宿主环境统一管理 Claude Code 版本

如果选择这个版本，请确保运行环境中已经存在可执行的 `claude` 命令，并满足 Wegent 要求的 Claude Code 最低版本。标准 `wegent-executor-linux-amd64` 仍会内置 Claude CLI，适合直接下载安装到普通 Linux 主机。

手动下载示例：

```bash
curl -fL -o wegent-executor \
  https://github.com/wecode-ai/Wegent/releases/latest/download/wegent-executor-linux-amd64-no-claude
chmod +x wegent-executor
```

#### 使用个人 Codex CLI 配置

默认情况下，executor 会使用 Wegent 下发的 Claude/Codex 模型和 provider 配置。需要使用个人 Codex 登录信息时，在 Wework 的【设置】->【个人】中从设备导入或上传 `~/.codex/auth.json`，再启用“个人配置”。设备心跳发现本机缺少 Codex auth 文件时，会在后台同步该认证；如果设备上已存在 `~/.codex/auth.json`，不会覆盖。使用 Codex 的 GPT 模型会通过该认证账户访问 Codex。

如果访问 Codex 需要代理，可以先在 Wework 的【设置】->【个人】->【代理】中保存个人代理地址，再回到【Codex 认证】中启用“Codex 代理”。Wegent 会在执行 Codex 时注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 以及对应的小写环境变量。已有 `NO_PROXY` 或 `no_proxy` 时会沿用现有值；未配置时默认绕过 `localhost`、`127.0.0.1`、`::1` 和 `host.docker.internal`。

Wegent 会根据用户设置在执行请求中显式标记 Codex 是否使用个人配置，不再通过 `WEGENT_LOCAL_CLI_CONFIG_RUNTIMES` 环境变量判断。

#### 统一管理本地 Skills

如果同一台本地设备同时使用 Claude Code 和 Codex，可以在 Wework 的【设置】->【编码】->【技能】中启用统一管理。Wegent 会在所选在线 Claude Code 设备上创建 `~/.agents/skills`，把 `~/.codex/skills` 和 `~/.claude/skills` 中已有的技能移动到该目录，并把两个旧目录改成指向 `~/.agents/skills` 的软链接。

该操作可以重复执行。重名技能不会被覆盖；系统会为后迁移的目录追加来源后缀，并在页面展示迁移数量。启用后，输入框里的本地 Skill 自动补全会把 `~/.agents/skills` 中的技能视为 Claude 和 Codex 都可用。

### 构建设备镜像

仓库提供 `docker/device/Dockerfile` 用于构建云设备或本地设备基础镜像。该镜像会安装 `code-server`、`weiboplat.wecoder-agent` 扩展、Claude Code CLI、Node.js 22、Python、Git，并把 `executor/dist/wegent-executor` 放到 `/app/executor` 和 `~/.wecode/wegent-executor/bin/wegent-executor`。

镜像内默认用户为 `wegent`，默认密码为 `wegent`。该账号用于容器内 code-server 和终端 shell 场景；生产部署时建议通过运行时配置、访问控制或上游平台认证限制访问范围。

构建前请先准备与目标平台匹配的 Linux executor 二进制，并确认基础镜像也支持同一平台。例如构建 Linux AMD64 镜像时，`executor/dist/wegent-executor` 必须是 Linux x86-64 ELF 文件，不能使用 macOS 的 Mach-O 二进制；构建 Linux ARM64 镜像时，基础 Ubuntu 镜像的 rootfs 也必须是 arm64。

```bash
WECODE_CLI_CC_TOKEN=xxx \
WECODE_CLI_CC_INSTALL_URL=xxx \
docker buildx build --platform linux/amd64 \
  -f docker/device/Dockerfile \
  -t wegent-device:linux-amd64 \
  --secret id=wecode_cli_cc_token,env=WECODE_CLI_CC_TOKEN \
  --secret id=wecode_cli_cc_install_url,env=WECODE_CLI_CC_INSTALL_URL \
  --load .
```

如果镜像中已经安装 Claude Code，建议使用 `wegent-executor-linux-amd64-no-claude` 作为 `executor/dist/wegent-executor` 的输入，避免在 executor 二进制和镜像中重复携带 Claude CLI。

运行设备镜像时通过环境变量传入 executor 连接信息，不要把 token 写入镜像：

```bash
docker run -d --platform linux/amd64 \
  --name wegent-device \
  -p 17888:17888 \
  -e CODE_SERVER_PASSWORD=wegent \
  -e EXECUTOR_MODE=local \
  -e WEGENT_BACKEND_URL=http://localhost:8000 \
  -e WEGENT_AUTH_TOKEN="$WEGENT_AUTH_TOKEN" \
  -e DEVICE_PUBLIC_BASE_URL=http://localhost:17888 \
  wegent-device:linux-amd64
```

设备镜像默认只启动 `wegent-executor` 和 code-server session gateway。Wework 项目终端通过 Backend 和 Executor 之间已有的 Socket.IO 连接中转，不要求设备有公网地址；IDE/code-server 和桌面 VNC/VPN 入口仍然只对云设备开放。

- `POST /api/projects/{project_id}/terminal`：在项目路径中启动可写 PTY，返回 `transport=socketio` 的终端会话 ID；浏览器通过 Backend `/terminal` Socket.IO namespace 连接。
- `POST /api/projects/{project_id}/code-server`：返回带短期 token 的 code-server 访问 URL。设备镜像内的 code-server 使用固定密码运行，session gateway 会在服务端自动登录，浏览器不会看到 code-server 登录页或固定密码。

Terminal 会话适用于本地设备和云设备：Backend 记录 `session_id`、用户、设备和 executor socket 绑定关系，前端使用登录 JWT 连接 `/terminal` namespace，Backend 再通过 `/local-executor` namespace 把输入、resize、关闭事件转发给设备，设备上的 Executor 直接管理 PTY。code-server 是容器内持久进程，通过 gateway 按项目路径打开目录；本地设备不支持 code-server 项目会话。

如果项目配置了 `workspace.localPath` 或 `workspace.checkoutPath`，设备会在启动 terminal 或 code-server 前自动创建该目录。若请求携带任务 ID 且该任务记录了执行工作区路径（例如 Git 新工作树），terminal 或 code-server 会直接在任务工作区路径中启动，不会回退到项目目录。

### 非项目会话工作区

Wework 入口的新对话在未选择项目（`project_id=0`）且绑定到在线设备时，Executor 会默认使用独立 Chats 工作区。如需关闭，可在设备运行环境中设置 `WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED=false`。Frontend 设备对话保留旧行为，仍使用任务临时工作区。

首轮任务会在 Chats 工作区树中创建目录，目录名根据日期和用户请求生成。默认根目录为 `~/.wecode/wegent-executor/workspace/chats`。如需自定义位置，可在设备运行环境中设置 `WEGENT_EXECUTOR_CHATS_DIR`。Backend 会把最终路径写入任务元数据标签 `standaloneChatWorkspacePath`，后续继续该会话或打开历史会话时会复用同一目录。

项目会话不使用 Chats 工作区路径；项目会话默认使用项目配置中的 `workspace.localPath` 或 `workspace.checkoutPath`。如果当前任务使用 Git 新工作树，项目工具会使用任务记录的工作树路径。

#### 安装指定版本

**macOS / Linux：**
```bash
curl -fsSL https://github.com/wecode-ai/Wegent/releases/download/v1.0.0/local_executor_install.sh | bash -s -- --version v1.0.0
```

**Windows (PowerShell)：**
```powershell
$env:WEGENT_VERSION='v1.0.0'; irm https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1 | iex
```

#### 手动安装（开发环境）

1. 克隆或下载 Wegent 仓库
2. 安装依赖：

```bash
cd executor
pip install -e .
```

### 启动 Executor

以本地设备模式运行 executor：

```bash
# 使用环境变量或 ~/.wegent-executor/device-config.json 中的配置启动
wegent-executor

# 或用环境变量临时覆盖配置文件中的连接信息
export WEGENT_AUTH_TOKEN=your_jwt_token
export WEGENT_BACKEND_URL=https://your-wegent-instance.com
wegent-executor
```

安装脚本和首次启动会创建 `~/.wegent-executor/device-config.json`。配置优先级是环境变量、device config、默认值；如果没有传 `EXECUTOR_MODE`、`WEGENT_BACKEND_URL` 或 `WEGENT_AUTH_TOKEN`，executor 会读取该文件中的 `mode`、`connection.backend_url` 和 `connection.auth_token`。

### 获取 JWT Token

1. 登录 Wegent Web 界面
2. 进入 **设置** → **API Token**
3. 点击 **生成** 创建新 token
4. 复制 token 用于启动 executor

> **注意**：Token 有效期为 7 天，过期后需要重新生成。

---

## 🖥 使用本地设备

### 选择设备

在聊天界面中，您会看到设备选择器下拉菜单：

1. 点击聊天输入框附近的 **设备选择器** 图标
2. 查看可用设备及其状态：
   - 🟢 **在线**：设备已连接且就绪
   - 🔴 **离线**：设备未连接
   - 🟡 **繁忙**：设备已达最大容量
3. 选择您想使用的设备
4. 像往常一样发送消息

### 设备状态指示

| 状态 | 图标 | 描述 |
|------|------|------|
| **在线** | 🟢 | 设备已连接，有可用槽位 |
| **离线** | 🔴 | 设备未连接 |
| **繁忙** | 🟡 | 所有 5 个并发槽位均被占用 |
| **默认** | ⭐ | 您的新任务默认设备 |

### 并发任务槽位

每个设备支持最多 **5 个并发任务**：

- 查看槽位使用情况："2/5 槽位使用中"
- 所有槽位被占用时设备显示"繁忙"
- 如果选择繁忙设备，任务会排队等待

### 云端与本地切换

您可以动态选择执行位置：

| 选择 | 行为 |
|------|------|
| **云端**（默认） | 任务在 Wegent 云端基础设施上执行 |
| **本地设备** | 任务在您选择的本地机器上执行 |

只需在发送每条消息之前更改设备选择即可。

### 项目中使用本地设备

创建项目时可以选择在线或繁忙的 ClaudeCode 本地设备。项目创建后，AI 任务会在该本地设备上执行，并使用项目配置中的本地路径或检出路径。

本地设备不支持项目工具栏中的云端连接能力：

| 功能 | 本地设备支持 |
|------|--------------|
| **终端** | 不支持 |
| **IDE/code-server** | 不支持 |
| **桌面 VNC/VPN** | 不支持 |
| **CPU/MEM/磁盘监控** | 不支持 |

如果项目绑定本地设备，工作区工具栏会隐藏终端、IDE 和桌面入口，并显示本地设备能力限制提示。需要这些连接和监控能力时，请选择云设备创建项目。

### 设置默认设备

1. 在选择器中打开设备列表
2. 点击您首选设备旁边的 **星号图标**
3. 该设备将在新对话中被预先选中

---

## ⚙️ 设备管理

### 查看已注册设备

通过以下方式访问您的设备：

1. **设备选择器**：聊天界面中快速访问
2. **设置页**：进入 **设置** → **连接** 查看可连接设备
3. **API**：`GET /devices` 用于程序化访问

### 管理连接页设备

**设置** → **连接** 页面会列出当前账号可连接的 ClaudeCode 设备，包括云设备和本地设备。页面仅展示 `bind_shell=claudecode` 的设备，并按云设备、本地设备分组。

云设备会显示在线状态、executor 版本、CPU、内存和磁盘使用率。当没有云设备时，点击 **添加** 可以创建一台新的云设备。创建请求返回后，页面会保留“云设备创建中”的提示；初始化通常需要 2-3 分钟，设备上线后会自动出现在列表中。Wework 前端可通过 `VITE_CLOUD_DEVICE_SCALING_WIKI_URL` 配置资源说明卡中的扩容 Wiki 链接，用于引导用户在 CPU、MEM 或磁盘持续超过 80% 时申请扩容或清理工作区缓存。

本地设备会显示设备名称、在线状态和 executor 版本，但不会展示 CPU、MEM、磁盘监控数据和资源监控说明，也不会展示终端、IDE、桌面 VNC/VPN、重启或删除云资源等云设备专属操作。离线本地设备会显示删除入口，用于移除该设备的注册记录；如果设备重新连接，它会自动重新注册。

在线云设备支持直接打开交互式会话：

| 操作 | 后端接口 | 说明 |
|------|----------|------|
| **终端** | `POST /api/devices/{device_id}/terminal` | 在默认工作目录 `/home/ubuntu/.wegent-executor/workspace` 启动 PTY；请求 body 可传 `path` 指定工作目录，并通过 Backend Socket.IO 中转 |
| **IDE** | `POST /api/devices/{device_id}/code-server` | 打开 code-server 会话 |

终端会话不暴露设备端口；IDE 返回的访问地址带有短期 session token，并通过设备侧 session gateway 暴露。设备离线时，终端和 IDE 按钮不可用。

更多菜单提供低频管理操作：

| 操作 | 说明 |
|------|------|
| **重命名** | 点击设备名称或编辑图标，保存后会刷新列表 |
| **重启设备** | 需要二次确认；设备会短暂离线，进行中的连接可能中断 |
| **删除设备** | 需要二次确认；云资源会被释放 |

### 设备信息

每个设备显示：

| 字段 | 描述 |
|------|------|
| **名称** | 设备主机名（如 "Darwin - MacBook-Pro.local"） |
| **状态** | 在线/离线指示器 |
| **版本** | executor 版本（如适用） |
| **资源使用率** | CPU、内存、磁盘使用率（仅云设备） |
| **槽位** | 并发任务容量（X/5） |
| **默认** | 如果设为默认则显示星号 |

### 管理设备

| 操作 | 方法 |
|------|------|
| **设为默认** | 点击星号图标 |
| **取消默认** | 再次点击当前默认设备的星号 |
| **删除设备** | 点击删除图标 |

> **注意**：本地设备的删除只是移除注册记录。如果设备重新连接，它会自动重新注册。云设备在连接设置页删除时会释放对应云资源。

### 离线设备处理

当设备离线时：

1. 系统会先等待一个很短的重连确认窗口，避免瞬时网络抖动误判为离线
2. 如果设备未在确认窗口内恢复，运行中的任务会自动标记为 **失败**
3. 错误消息指示设备断开连接
4. 任务槽位会在确认设备离线后释放
5. 设备在选择器中显示为灰色

---

## ❓ 常见问题

### 连接问题

#### 设备无法连接

**可能原因：**
1. JWT token 无效或已过期
2. 网络连接问题
3. 后端 URL 配置错误

**解决方案：**
1. 从 Wegent UI 生成新的 JWT token
2. 检查到 Wegent 后端的网络连接
3. 验证 `~/.wegent-executor/device-config.json` 或 `WEGENT_BACKEND_URL` 环境变量

#### 设备连接后立即显示离线

**可能原因：**
1. Token 验证失败
2. 防火墙阻止 WebSocket
3. 后端服务问题

**解决方案：**
1. 检查 token 有效性和权限
2. 确保允许 WebSocket 连接
3. 检查 Wegent 后端日志中的错误

### 任务执行问题

#### 任务立即失败

**可能原因：**
1. Claude Code SDK 未安装
2. 本地机器缺少依赖
3. 权限不足

**解决方案：**
1. 安装并配置 Claude Code SDK
2. 安装所需依赖
3. 检查文件系统权限

#### 任务挂起无进展

**可能原因：**
1. Claude Code SDK 卡住
2. 执行期间网络中断
3. 本地机器资源耗尽

**解决方案：**
1. 重启 executor
2. 检查网络连接
3. 监控本地资源使用（CPU、内存）

### 设备管理问题

#### 多个设备显示相同名称

这是正常的，如果您有多台主机名相似的机器。每个设备有基于硬件的唯一 ID。

#### 无法删除设备

如果设备在删除后不断重新出现，说明 executor 仍在运行并重新注册。请先停止 executor，然后再删除。

---

## 💡 最佳实践

### 何时使用本地设备

| 使用场景 | 建议 |
|----------|------|
| **敏感代码库** | ✅ 本地设备 |
| **快速迭代** | ✅ 本地设备 |
| **自定义工具需求** | ✅ 本地设备 |
| **批量处理** | 云端（更大容量） |
| **团队协作** | 云端（共享访问） |
| **移动/远程访问** | 云端（无需本地设置） |

### 多设备设置

如果您有多台机器：

1. 分别注册每台设备
2. 使用描述性主机名便于识别
3. 将主要工作站设为默认
4. 设备离线时使用云端作为后备

### 资源管理

- 任务执行期间监控本地资源使用
- 关闭不必要的应用程序以获得更好性能
- 考虑使用 SSD 存储以加快文件操作
- 确保有足够的 RAM 供 Claude Code SDK 使用

---

## 🔗 相关资源

### 文档
- [核心概念](../../concepts/core-concepts.md) - 了解 Wegent 的架构
- [管理任务](../chat/managing-tasks.md) - 了解任务执行

### 技术参考
- [本地设备架构](../../developer-guide/local-device-architecture.md) - 技术架构详解

---

## 💬 获取帮助

需要帮助？

- 📖 查看 [常见问题](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">在本地机器上执行 AI 任务，完全掌控！ 🚀</p>
