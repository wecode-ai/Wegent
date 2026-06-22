---
sidebar_position: 16
---

# 本地运行时任务

Wework 的本地运行时任务用于展示和继续用户已经在设备上创建的 Codex 或 Claude Code 工作。它不再把这些工作导入中心库的 `TaskResource` 或 `Subtask`，而是按三层结构展示：

```text
Project
  Device Workspace
    LocalTask
```

## 数据归属

- Project 是中心状态，仍由 Backend 管理。
- Device Workspace 是中心映射，表示某个用户、设备和本地目录属于哪个 Project。
- LocalTask 是 executor 本机状态，只保存在设备上。
- LocalTask 的稳定身份是 `deviceId + localTaskId`。`workspacePath` 只作为设备工作区上下文使用，用于列表分组、创建任务和右侧工具定位目录；任务 URL、IM 通知订阅和原生 Codex 更新去重都不把路径作为身份字段。

executor 的 LocalTask 索引使用 JSON 文件保存：

```text
$WEGENT_EXECUTOR_HOME/runtime-work/index.json
```

它不依赖 SQLite，也不把 Codex 或 Claude Code 的本地运行时句柄同步到中心数据库。

## 列表刷新

任务列表由前端轮询触发。

1. Wework 定时请求 `GET /api/runtime-work?client_origin=wework`。
2. Backend 读取当前用户的 Project 和 Device Workspace 映射。
3. Backend 通过在线设备的 WebSocket RPC 调用 `runtime.tasks.list`。
4. executor 刷新本机 Codex 发现结果和 JSON LocalTask 索引。
5. Backend 按 `deviceId + workspacePath` 分组返回 Project -> Device Workspace -> LocalTask，但每个 LocalTask 的打开和通知身份仍是 `deviceId + localTaskId`。

executor 不主动向 Backend 轮询或推送任务列表。离线设备不会贡献 LocalTask；Wework 可以显示映射目录离线，但不会从中心库缓存本地任务。

## 打开和继续任务

打开 LocalTask 时，Wework 调用 Backend：

```text
POST /api/runtime-work/transcript
```

Backend 将 `deviceId + localTaskId` 转发给对应设备的 `runtime.tasks.transcript`。如果请求里带有 `workspacePath`，executor 会把它作为本地索引查找提示；如果没有，executor 通过本机 LocalTask 索引按 `localTaskId` 定位任务。executor 读取原生运行时 transcript，并返回标准化消息。

继续 LocalTask 时，Wework 调用：

```text
POST /api/runtime-work/send
```

Backend 转发 `runtime.tasks.send`。executor 根据本地 LocalTask 的 opaque runtime handle 继续运行时会话。Claude Code 任务会把本地 transcript 写回 JSON LocalTask 索引；原生 Codex 任务只继续 Codex SDK thread，消息和状态以 Codex 自己的 session 记录为准，不写回 executor JSON 索引。流式 Responses 事件只携带 `local_task_id` 和运行时信息，不携带 `workspacePath`。

原生 Codex 任务有一个额外约束：刷新 transcript 时只信任 Codex 本身的会话记录。fork 包或 executor JSON 索引中携带的 `runtimeHandle.messages` 只是导入瞬间的快照，不能作为原生 Codex transcript 的回退来源，否则 Wework 刷新后会显示旧消息或丢失用户追问。非 SDK 原生任务仍可以使用 executor JSON 索引中的本地 transcript。

## 工作区工具上下文

Wework 打开 LocalTask 后，右侧文件、审查和终端工具使用当前 LocalTask 的设备和目录上下文解析设备与目录：

- 优先使用 `runtime.tasks.list` 返回的 LocalTask `workspacePath`，这样 Codex worktree 不会被当成另一个 Project。
- 如果 LocalTask 能映射到 Project，环境信息和审查仍带上 Project，但 Git 命令运行在 LocalTask 的实际目录。
- 如果 LocalTask 没有映射到 Project，只要设备在线且目录可访问，本地终端仍可打开；依赖 Project API 的 IDE 能力仍要求 Project 上下文。
- 对运行时 LocalTask 打开的终端必须使用当前 LocalTask 的 `deviceId + workspacePath` 启动设备级 PTY，不能回退到 Project 默认绑定设备，否则跨设备 worktree 会打开到错误机器。

## 创建任务

创建新的运行时任务时，Wework 调用：

```text
POST /api/runtime-work/create
```

Backend 根据请求中的项目映射或独立设备工作区解析目标设备和目录，构造一次临时 execution request，然后调用设备 RPC `runtime.tasks.create`。这个流程不会 `db.add()` 任何 `TaskResource` 或 `Subtask`。

运行时创建的持久化位置由具体 runtime 决定：

- Claude Code 创建 executor JSON LocalTask，并在该索引中保存 transcript 和 runtime handle。
- Codex 创建原生 Codex SDK thread。`runtime.tasks.create` 返回的 `localTaskId` 是 Codex threadId，后续列表和 transcript 只从原生 Codex discovery/session 读取，不把 Codex 任务缓存到 executor JSON 索引。
- Codex 创建时仍通过 LocalTask Responses 事件通道流式返回 `response.created`、文本/tool 增量和 `response.completed`/`error`，前端不需要等待下一次列表刷新才能显示运行中的回复。
- 附件仍由 executor 的 Codex attachment pipeline 处理：Backend 只传 attachment id，executor 在目标设备上下载并转换给 Codex SDK，前端不传本地附件路径。

Project 场景必须使用可信的 Device Workspace 映射：

- Wework 发送 `projectId + deviceWorkspaceId`，不发送 `workspacePath`。
- Backend 校验 `deviceWorkspaceId` 属于当前用户和该 `projectId`，并且映射里包含可信的 `deviceId + workspacePath`。
- 如果同一个 Project 只有一个可用 Device Workspace，前端可以直接选中；如果有多个可用 Device Workspace，前端必须让用户确认运行位置后再发送。
- 旧版 Project 配置里保存的 `execution.deviceId + workspace.localPath` 会在 runtime work 列表刷新时物化为 Device Workspace 映射，以便旧项目也走同一套可信映射路径。

非 Project 的独立设备工作区仍使用 `deviceId + workspacePath` 创建任务。该路径只适用于用户显式选择的未映射设备工作区，不能用于 Project 任务的前端透传。

## 复制和跨设备转移

复制运行时任务时，Wework 只在当前任务所属 Project 内选择目标工作区：

- 已经绑定到该 Project 的其他 Device Workspace 可以直接作为目标。
- 没有绑定到该 Project 的在线设备，需要先走和项目创建/编辑一致的设备目录准备流程：选择设备目录，并选择该目录在 Project 下的类型是 `worktree` 还是普通 `workspace`。
- Backend 调用 `POST /api/runtime-work/device-workspaces/prepare` 写入 Device Workspace 映射后，再继续执行任务复制。
- Device Workspace 的 `label` 可以保存 `worktree` 或 `workspace`。Backend 返回 runtime work 列表时会优先用这个标签作为 `workspaceKind`，这样前端不会把同一 Project 下的 worktree 当成另一个 Project，也不会展示无关 Project 或未映射目录作为复制目标。
- 如果 Project 配置了 `git` 信息，Backend 会先确认源和目标工作区的 Git remote 相同，并确认源任务的 `HEAD` commit 在目标仓库可达。确认成功后，目标设备不会直接在 Project 主目录上导入任务，而是在目标项目工作区对应的 `worktrees/<transferId>/<projectDir>` 路径创建或复用一个 detached Git worktree，再把 fork 后的 LocalTask 绑定到这个 worktree 路径。这样复制任务不会污染目标 Project 主目录，列表刷新时也能把 worktree 下的任务归回同一个 Project。
- Git fork 复制任务上下文、Codex 会话状态、必要的会话文件，以及从公共 base commit 生成的轻量 Git patch。该 patch 覆盖源工作区中的本地 commit、未提交的 tracked 文件修改，以及未被 ignore 的 untracked 文件 overlay；不会把完整 Git 仓库目录打包上传到对象存储。如果 Git 条件不满足，才进入普通 archive 传输。
- 如果 Project 不是 Git 工作区，复制才会走 executor 的直接 archive 传输，并在直连不可用时使用对象存储兜底。
- 直接 archive 传输只尝试 Backend 从 WebSocket 连接看到的 TCP peer host 和 executor 上报的 runtime transfer host。executor 会用一次带 token 的 probe 验证对端，避免把业务上报的 NAT/代理地址直接当成可信目标。直连不可用且没有对象存储配置时，Backend 返回 503，而不是静默落入不可用的 S3 路径。

复制任务的身份仍然使用 `deviceId + localTaskId`。`workspacePath` 只用于定位目标设备目录和工作区工具上下文。

## 非 Project 工作区

executor 发现但没有映射到中心 Project 的目录会在 Wework 的“未映射工作区”中显示。它们同样来自在线设备的 `runtime.tasks.list` 返回值，而不是中心数据库任务。

## IM 通知

运行时任务可以向 IM 会话发送通知，但通知状态以 `deviceId + localTaskId` 为准，不创建 DB Task，也不把 `workspacePath` 写进通知 key。

- 在 IM 中使用 `/notify on`、`/通知 开` 开启当前用户的全局运行时任务通知目标。
- 使用 `/notify off` 关闭全局通知，使用 `/notify status` 查看当前状态。
- 单个 IM 会话订阅某个运行时任务后，只接收该任务的更新。
- executor 发现原生 Codex 任务更新时间变化时，只在最后一条 assistant 消息进入终态且有回复内容后，通过设备 WebSocket 发送不含 `workspacePath`、但包含 `status` 和 `content` 的 `runtime.tasks.updated`。Backend 会忽略运行中/流式更新，并按订阅和全局通知设置把终态回复投递到 IM。
- Wegent 发起的 runtime send 与原生 Codex watcher 使用同一个 `deviceId + localTaskId` 去重，避免 Codex 和 Wework 对同一次任务更新重复通知。

## URL

Wework 的运行时任务 URL 使用：

```text
/runtime-tasks?deviceId=<device>&localTaskId=<local-task>
```

URL 不包含 `workspacePath`。刷新页面或复制链接时，前端先用 URL 里的 `deviceId + localTaskId` 打开任务，再从最新的 runtime work 列表恢复该任务的工作区上下文。

## 兼容性

Wegent 原生 Task/Subtask 流程仍保留给现有聊天、共享任务和历史 task URL。Wework sidebar、移动端 drawer、项目下任务展示和新任务创建路径使用 runtime work API，不再依赖 DB task list。
