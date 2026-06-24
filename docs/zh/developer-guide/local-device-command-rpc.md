---
sidebar_position: 18
---

# 本地设备命令 RPC

本地设备命令 RPC 允许 Backend 向指定在线 local executor 设备下发一条预配置的本机 shell 命令，并等待命令完成后拿到结果。该能力用于运维检查、工作区诊断和后端主动探测，不参与 Task/Subtask 生命周期，也不会产生聊天消息。

## 架构

通信路径如下：

1. API 调用方传入 `command_key`。
2. Backend 从 `LOCAL_DEVICE_COMMANDS` 配置中解析出实际 shell 命令。
3. Backend 从 Redis 在线设备信息中读取目标设备的 Socket.IO `socket_id`。
4. Backend 在 `/local-executor` namespace 上调用 `device:execute_command`。
5. local executor 的 `CommandHandler` 在本机执行命令。
6. executor 通过 Socket.IO ack 一次性返回完成结果。
7. Backend 按命令定义中的 `post_processor` 对结果做可选后处理。

该 RPC 与 `task:execute` 解耦，适合短命令和一次性诊断命令。长时间交互式终端、实时 stdout/stderr 流式输出不通过该 RPC 承载。macOS WeWork App 的本地项目终端使用 Tauri 本地 PTY 嵌入在页面内，见下文“macOS App 本地终端”。

## API

请求：

```http
POST /api/devices/{device_id}/commands
```

请求体：

```json
{
  "command_key": "repo_status",
  "path": "/optional/path",
  "args": ["--short"],
  "env": {
    "KEY": "VALUE"
  },
  "timeout_seconds": 60,
  "max_output_bytes": 1048576
}
```

响应：

```json
{
  "success": true,
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "duration": 0.42,
  "timed_out": false,
  "stdout_truncated": false,
  "stderr_truncated": false
}
```

命令启动失败、返回非零退出码或超时时，`success` 为 `false`。超时结果会包含 `timed_out=true` 和 `error`。

`path` 是命令执行目录；`cwd` 仍作为旧字段兼容，两个字段同时传入时优先使用 `path`。`args` 是追加到配置命令后的参数数组，不会拼接成 shell 字符串。例如 `command_key=ls_a`、`path=/repo`、`args=["backend"]` 会在 `/repo` 下执行 `["ls", "-a", "backend"]`。

## 安全与限制

该能力按“Backend 可信、API 受限”模型设计。HTTP API 不接受原始命令，只接受配置 key；实际命令必须由 Backend 通过命令 registry 或 `LOCAL_DEVICE_COMMANDS` 预配置。默认内置 `pwd`、`home_dir`、`project_workspace_root`、`ls_a`、`ls_dirs`、`workspace_tree`、`workspace_read_text_file`、`project_folder_status`、`mkdir_p`、`path_exists`、`git_*`、`ls_skills`、`codex_threads_list`、`setup_shared_skills`、`open_terminal`、`sync_runtime_auth_file`、`read_runtime_auth_file`、`turn_file_changes_review` 和 `turn_file_changes_revert` 命令 key。其中 `ls_a` 会使用 `file_list` 后处理器过滤 `.`、`..` 并在 `stdout` 中返回文件名数组，`ls_dirs` 会使用 `directory_list` 后处理器只返回当前目录下的子目录名称数组；workspace、runtime auth、Codex thread 和 turn file changes 相关命令使用 `json` 后处理器返回结构化数据。`open_terminal` 用于在支持图形界面的本地设备上打开系统终端窗口；它是一次性启动命令，不提供终端流式交互。新增内置命令只需要在 `backend/app/services/device/command_registry.py` 的 `DEFAULT_LOCAL_DEVICE_COMMANDS` 中增加一项。

运行时可通过一个环境变量增加或覆盖配置。简单命令可以直接写字符串；需要后处理时写对象：

```bash
LOCAL_DEVICE_COMMANDS='{"repo_status":"git status","repo_files":{"command":"ls -a","post_processor":"file_list"}}'
```

`git_clone` 的参数通过 `args` 传入，例如：

```json
{
  "command_key": "git_clone",
  "path": "/Users/yunpeng7/AIGCWorkSpace",
  "args": ["https://github.com/wecode-ai/Wegent.git", "Wegent"]
}
```

默认保护包括：

- 只有当前用户拥有且在线的设备可以被调用。
- API 只能执行 `LOCAL_DEVICE_COMMANDS` 中存在的命令 key。
- 命令结果只能使用 Backend 已注册的后处理器，API 调用方不能传入任意后处理函数。
- 默认超时 60 秒，最大 600 秒。
- stdout 和 stderr 分别默认最多返回 1 MiB，最大 5 MiB。
- Backend 和 executor 均记录命令、设备、耗时和退出码日志。

由于命令在用户本机执行，调用方必须把该 API 当作高权限操作处理，不应暴露给非可信入口。

### 单轮文件变更命令

`turn_file_changes_review` 和 `turn_file_changes_revert` 只接受 `turn-file-changes/<taskId>/<subtaskId>` 形式的 artifact id。运行时本地任务没有中心库 task row 时，`taskId` 可以是 `0`；两个路径段仍必须是纯数字，并且命令脚本会用 fullmatch 拒绝路径穿越。命令读取 `$WEGENT_EXECUTOR_HOME/artifacts/<artifactId>/metadata.json` 与 `changes.patch.gz`，校验 metadata 中的 workspace 和 patch checksum 后，才会返回 diff 或尝试安全撤销。

调用方应把这两个命令绑定到当前 LocalTask 的 `deviceId + workspacePath` 上，而不是绑定中心库 Task API。这样即使本地运行时任务没有 `TaskResource`/`Subtask`，审核和撤销也会发生在生成 artifact 的同一台设备和同一个工作区。

## Executor 行为

local executor 优先使用 Backend 下发的 `argv` 执行命令；缺少 `argv` 时才回退到系统 shell。`path`/`cwd` 为空时使用 executor 当前工作目录；`env` 会合并到当前进程环境中。命令超时时，executor 会终止命令进程组并返回超时结果。

## macOS App 本地终端

WeWork macOS App 访问本机 local executor 项目时，可以在工作区面板内嵌入本地终端。该终端由 App 通过 Tauri command 在本机创建 PTY，并用前端 `xterm` 组件渲染输入输出流；它不经过 `/devices/{device_id}/commands` RPC。

启用条件：

- 运行环境必须是 macOS Tauri App；普通浏览器和 iOS App 不启用。
- 项目绑定的设备必须是 local Claude Code 设备。
- App 与 executor 必须对应同一个后端。App 会把当前 `apiBaseUrl` 传给 native 层，native 层优先扫描正在运行的 `wegent-executor` 进程，并按进程环境中的 `WEGENT_BACKEND_URL` 匹配。
- 如果进程匹配不到，native 层才回退读取 `WEGENT_EXECUTOR_HOME`、`~/.wecode/wegent-executor/device-config.json`、`~/.wegent-executor/device-config.json` 等本地配置。
- 对项目终端，当前任务执行工作区路径或项目 `localPath` 在当前 Mac 上存在时也可作为同机信号，用于处理多个 executor 配置文件不同步的情况。终端启动时会把同一个路径作为 Tauri PTY 的 `cwd`。

这个判断不使用 IP 或 MAC 地址。IP 在代理、VPN、容器网络和本机回环场景下容易重复或失真；MAC 地址也可能因权限、虚拟网卡和隐私策略不稳定。运行中 executor 进程与后端 URL 匹配是更接近实际连接状态的信号。
