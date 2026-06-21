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
- Backend 和 Wework 只持有临时的 `RuntimeTaskAddress`：`deviceId`、`workspacePath`、`localTaskId`。

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
5. Backend 按 `deviceId + workspacePath` 分组返回 Project -> Device Workspace -> LocalTask。

executor 不主动向 Backend 轮询或推送任务列表。离线设备不会贡献 LocalTask；Wework 可以显示映射目录离线，但不会从中心库缓存本地任务。

## 打开和继续任务

打开 LocalTask 时，Wework 调用 Backend：

```text
POST /api/runtime-work/transcript
```

Backend 将 `RuntimeTaskAddress` 转发给对应设备的 `runtime.tasks.transcript`。executor 读取原生运行时 transcript，并返回标准化消息。

继续 LocalTask 时，Wework 调用：

```text
POST /api/runtime-work/send
```

Backend 转发 `runtime.tasks.send`。executor 根据本地 LocalTask 的 opaque runtime handle 继续 Codex 或 Claude Code 会话，并把结果写回本机 JSON LocalTask 索引。

## 工作区工具上下文

Wework 打开 LocalTask 后，右侧文件、审查和终端工具使用当前 `RuntimeTaskAddress` 解析设备与目录：

- 优先使用 `runtime.tasks.list` 返回的 LocalTask `workspacePath`，这样 Codex worktree 不会被当成另一个 Project。
- 如果 LocalTask 能映射到 Project，环境信息和审查仍带上 Project，但 Git 命令运行在 LocalTask 的实际目录。
- 如果 LocalTask 没有映射到 Project，只要设备在线且目录可访问，本地终端仍可打开；依赖 Project API 的 IDE 能力仍要求 Project 上下文。

## 创建任务

创建新的运行时任务时，Wework 调用：

```text
POST /api/runtime-work/create
```

Backend 根据请求中的 `projectId` 或 `deviceId + workspacePath` 解析目标设备和目录，构造一次临时 execution request，然后调用设备 RPC `runtime.tasks.create`。这个流程不会 `db.add()` 任何 `TaskResource` 或 `Subtask`。

## 非 Project 工作区

executor 发现但没有映射到中心 Project 的目录会在 Wework 的“未映射工作区”中显示。它们同样来自在线设备的 `runtime.tasks.list` 返回值，而不是中心数据库任务。

## IM 通知

运行时任务可以向 IM 会话发送通知，但通知状态仍以 `RuntimeTaskAddress` 为准，不创建 DB Task。

- 在 IM 中使用 `/notify on`、`/通知 开` 开启当前用户的全局运行时任务通知目标。
- 使用 `/notify off` 关闭全局通知，使用 `/notify status` 查看当前状态。
- 单个 IM 会话订阅某个运行时任务后，只接收该任务的更新。
- executor 发现原生 Codex 任务更新时间变化时，通过设备 WebSocket 发送 `runtime.tasks.updated`，Backend 再按订阅和全局通知设置投递到 IM。
- Wegent 发起的 runtime send 与原生 Codex watcher 使用同一个 `RuntimeTaskAddress` 去重，避免 Codex 和 Wework 对同一次任务更新重复通知。

## 兼容性

Wegent 原生 Task/Subtask 流程仍保留给现有聊天、共享任务和历史 task URL。Wework sidebar、移动端 drawer、项目下任务展示和新任务创建路径使用 runtime work API，不再依赖 DB task list。
