---
sidebar_position: 16
---

# 本地运行时任务

Wework 的本地运行时任务用于展示和继续用户已经在设备上创建的 Codex 或 Claude Code 工作。它不再把这些工作导入中心库的 `TaskResource` 或 `Subtask`，也不再依赖 Backend `projects` 表生成侧栏列表。列表来自在线设备 executor 返回的运行时线程，并在前端展示为两类：

```text
Project
  LocalTask

Conversation
  LocalTask
```

## 数据归属

- Project 是 executor 线程所属工作区的展示分组，由运行时列表里的工作区信息推导。
- Conversation 是没有项目归属的 Codex 对话线程展示分组。
- LocalTask 是 executor 本机状态，只保存在设备上。
- Project 的运行时身份是 `deviceId + workspacePath` 派生出的 workspace key，不使用中心库 `projects.id`。Wework 可以在组件内部生成临时 UI id，但不能把这个 id 写回 Backend 或放进 URL 作为项目身份。
- LocalTask 的稳定身份是 `deviceId + localTaskId`。`workspacePath` 只作为设备工作区上下文使用，用于列表分组、创建任务和右侧工具定位目录；任务 URL、IM 通知订阅和原生 Codex 更新去重都不把路径作为身份字段。
- executor 返回的 `workspaceKind` 用于区分 Project 与 Conversation。Codex App 风格的目录（例如 `~/Documents/Codex/YYYY-MM-DD/<name>`）会被标记为 `chat` 并展示到“对话”，其他工作区展示到“项目”。

executor 仍为非 Codex 或导入类本地任务保留 JSON LocalTask 索引：

```text
$WEGENT_EXECUTOR_HOME/runtime-work/index.json
```

原生 Codex 任务不写入这个索引。它们在列表刷新时通过 Codex SDK 和 Codex session 文件即时发现，运行中状态也从 Codex status 与 session transcript 推导。运行时句柄不依赖 SQLite，也不会同步到中心数据库。

## 列表刷新

任务列表由 Wework 在启动、显式刷新或设备状态变化时请求，不再由固定 interval 轮询触发。

1. Wework 请求 `GET /api/runtime-work`。
2. Backend 读取当前用户在线设备列表，并通过设备 WebSocket RPC 调用 `runtime.tasks.list`。
3. executor 刷新本机 Codex 发现结果，并合并非 Codex/导入类 JSON LocalTask 索引。
4. executor 在返回值中携带 `workspaceKind`、工作区路径、任务标题、更新时间和设备状态。
5. Backend 做轻量聚合后返回给 Wework，不再读取或匹配 Backend `projects` 表。
6. Wework 根据 runtime work 响应展示 Project 和 Conversation；每个 LocalTask 的打开和通知身份仍是 `deviceId + localTaskId`。

executor 不主动向 Backend 轮询或推送任务列表。离线设备不会贡献 LocalTask；Wework 可以显示映射目录离线，但不会从中心库缓存本地任务。

如果只有一个设备，Wework 不在项目名后显示设备 IP；如果有多个设备，本地设备不显示 IP，远端在线设备显示可用的非 loopback runtime transfer host 或客户端 IP，并配绿色在线点。远程项目和远程主机选择器的主显示文本也优先使用这个 IP/host；设备 id 只是缺少网络地址时的技术回退。

## 搜索

Wework 使用运行时搜索能力查找设备上的本地任务：

```text
POST /api/runtime-work/search
```

Backend 只向当前用户在线或 busy 的设备 fan-out `runtime.tasks.search` RPC，不读取中心库 `TaskResource`、`Subtask` 或历史缓存。executor 在本机任务标题和 transcript 中搜索，并返回匹配片段、消息元数据、更新时间、设备名、工作区路径和临时任务地址。

搜索结果按 `updatedAt` 倒序聚合，并受请求 `limit` 限制。`includeArchived` 传给 executor 决定是否包含已归档 LocalTask。请求携带 `projectId` 时，Backend 会根据工作区路径推导 Project，并只返回该 Project 下的搜索结果；`workspaceKind: chat` 的 Conversation 结果没有 Project 归属。

前端搜索框只打开结果里的 `deviceId + localTaskId` 地址，随后仍通过最新 runtime work 列表恢复工作区上下文。

## 打开和继续任务

打开 LocalTask 时，Wework 调用 Backend：

```text
POST /api/runtime-work/transcript
```

Backend 将 `deviceId + localTaskId` 转发给对应设备的 `runtime.tasks.transcript`。原生 Codex 任务通过 Codex session path 或 session 文件发现定位；非 Codex/导入类任务可以使用 `workspacePath` 作为本地索引查找提示，或者通过本机 LocalTask 索引按 `localTaskId` 定位。executor 读取原生运行时 transcript，并返回标准化消息。

继续 LocalTask 时，Wework 调用：

```text
POST /api/runtime-work/send
```

Backend 转发 `runtime.tasks.send`。executor 根据本地 LocalTask 的 opaque runtime handle 继续运行时会话。Claude Code 任务会把本地 transcript 写回 JSON LocalTask 索引；原生 Codex 任务只继续 Codex SDK thread，消息和状态以 Codex 自己的 session 记录为准，不写回 executor JSON 索引。流式 Responses 事件只携带 `local_task_id` 和运行时信息，不携带 `workspacePath`。

如果当前 LocalTask 仍在回复，Wework 会把新的用户输入放入本地队列，而不是并发调用 `runtime.tasks.send`。用户可以取消队列中的消息；也可以在队列面板中选择“暂停当前回复并发送”，这会先调用：

```text
POST /api/runtime-work/cancel
```

Backend 将 `deviceId + localTaskId` 转发为 `runtime.tasks.cancel`。executor 对原生 Codex 任务取消当前进程内正在运行的 SDK task，清理 running 标记，并让 Responses 流发出 incomplete 状态；非 Codex runtime 由各自 adapter 的 `cancel` 能力处理。取消成功后，前端才发送队列中的下一条消息。这个流程仍只使用 `deviceId + localTaskId` 定位任务，`workspacePath` 只是设备目录上下文。

继续 LocalTask 时可以携带已经上传并处于 ready 状态的 attachment id。Backend 会校验这些附件属于当前用户并转换成 executor 需要的附件元数据，executor 再在目标设备上下载、转换并交给 runtime。前端不会把本机附件路径直接发送给 Backend 或 executor。

## 已归档会话

已归档会话同样是设备侧状态。Backend 只做用户、设备和工作区校验，然后把请求转发给目标 executor；它不会读取或写入 `TaskResource.STATE_ARCHIVED`，也不会调用中心库 `/tasks/archived`。Wework 的归档列表只从运行时 Project 和 Conversation 范围内产生，避免展示不属于当前 Codex Lite 侧栏的数据。

归档相关 HTTP API 包括：

```text
POST /api/runtime-work/archived-conversations/list
POST /api/runtime-work/archived-conversations/archive
POST /api/runtime-work/archived-conversations/archive-project
POST /api/runtime-work/archived-conversations/archive-all
POST /api/runtime-work/archived-conversations/unarchive
POST /api/runtime-work/archived-conversations/delete
POST /api/runtime-work/archived-conversations/delete-bulk
```

executor 对原生 Codex 会话通过 Codex SDK 或本机 Codex state 执行 archive/unarchive；删除已归档会话时，需要在设备侧移除对应 Codex 本地 state 行以及 rollout/session 文件。列表响应会标准化 `id`、`localTaskId`、标题、Project 名称、工作区路径、设备、来源和时间字段，并按 Project 汇总计数。批量删除只作用于前端当前提交的归档项集合。

图片附件上传成功后，Wework 会在当前页面的 `Attachment` 对象上保留一个前端本地的 `local_preview_url`，用于发送后立即展示图片预览，避免刚发送的消息再通过附件下载接口拉取同一张图片。该字段只属于前端渲染状态，不写入 Backend，也不会进入 `attachment_ids` 或 executor 请求；页面刷新后仍以持久化附件 ID 为准重新读取附件。

消息渲染时，如果消息已经带有持久化图片附件，Wework 优先展示附件预览，并忽略 Codex prompt 中的本地图片文件提及，避免同时展示上传附件和临时本机路径。只有没有附件记录时，才把 Codex 本地图片提及作为本机预览兜底；如果当前环境不能通过 Tauri `convertFileSrc` 转换本机路径，或转换后的图片加载失败，前端不展示该本机路径。

executor 从原生 Codex session 发现用户消息时，会把 `local_images`、`localImages` 或 `images` 中的本机图片路径写入用户可见文本，保持刷新后仍能看到“用户提到了哪些文件”。如果这些路径在当前设备上可读、是图片 MIME 类型且不超过 5 MB，executor 会额外生成只用于 transcript 渲染的 ready 附件，并把 `local_preview_url` 写成 data URL。这个预览附件不代表 Backend 持久化附件，也不会上传或同步到中心库。

原生 Codex 任务有一个额外约束：刷新 transcript 时只信任 Codex 本身的会话记录。fork 包或 executor JSON 索引中携带的 `runtimeHandle.messages` 只是导入瞬间的快照，不能作为原生 Codex transcript 的回退来源，否则 Wework 刷新后会显示旧消息或丢失用户追问。非 SDK 原生任务仍可以使用 executor JSON 索引中的本地 transcript。

runtime transcript 中的 assistant 消息可以携带 `fileChanges` 摘要。原生 Codex 创建和继续任务时，executor 会把 `NativeTurnFileChangeTracker` 接到 Codex SDK 的 `turn/diff/updated` 事件上，记录最新的本轮累计 diff；回复完成时 tracker 通过 Responses completion fields 返回 `file_changes`，`runtime.tasks.create`、`runtime.tasks.send` 和 `runtime.tasks.transcript` 都必须把它规范化为消息上的 `fileChanges`。这样前端无需等待下一次列表刷新，就能在当前 assistant 消息下显示本轮文件变更卡片。

Wework 展示文件变更卡片时，运行时 LocalTask 不走中心库 Task API，而是通过当前任务的 `deviceId + workspacePath` 调用设备命令 `turn_file_changes_review` 或 `turn_file_changes_revert`。这样 review 和 revert 都发生在生成该 LocalTask 的实际设备目录中。运行时本地任务可能没有中心库 `TaskResource`/`Subtask`，因此 artifact id 允许使用 `turn-file-changes/0/<subtaskId>` 这类纯数字路径；设备命令仍必须用完整正则匹配 artifact id，并从 metadata 校验 workspace 与 patch checksum，不能接受任意路径。若本地 artifact 缺失或回滚冲突，前端会把对应状态写回当前 transcript 消息，避免继续展示过期的可操作状态。

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

Wework 在调用 create 前先生成客户端侧 `localTaskId`，并在请求体中作为 `localTaskId` 传给 Backend。Backend 只把这个值转发给目标设备，不把它写入中心数据库。前端会立即用 `deviceId + localTaskId` 打开运行时 URL、展示用户消息和等待态；如果设备返回了不同的 `localTaskId`，前端再切换到设备确认的地址。这样新建任务不需要等待 Backend RPC 完成或下一次列表刷新，队列发送也会等当前等待态进入真实 assistant turn 后再继续。

运行时创建的持久化位置由具体 runtime 决定：

- Claude Code 创建 executor JSON LocalTask，并在该索引中保存 transcript 和 runtime handle。
- Codex 创建时先返回 executor 进程内的 `localTaskId`，让前端立即打开任务并接收 stream；后台启动原生 Codex SDK thread 后，会把真实 Codex threadId 保存在内存 runtime handle 中用于后续 send/resume。
- Codex 创建和继续时都不把任务缓存到 executor JSON 索引。当前 executor 进程内会保留一个临时内存记录，用来覆盖 Codex discovery 尚未发现新 thread 的短暂空窗；executor 重启后再以原生 Codex discovery/session 为准。
- Codex 创建时仍通过 LocalTask Responses 事件通道流式返回 `response.created`、文本/tool 增量和 `response.completed`/`error`，这些事件使用 create 返回的 `localTaskId`，前端不需要等待下一次列表刷新才能显示运行中的回复。
- 附件仍由 executor 的 Codex attachment pipeline 处理：Backend 只传 attachment id，executor 在目标设备上下载并转换给 Codex SDK，前端不传本地附件路径。
- Codex 回复完成时如果 Responses `response.completed` 中带有 `file_changes` 或 `fileChanges`，executor 会把它保存到当前 assistant message 的 `fileChanges` 字段，后续 transcript 刷新继续展示同一张文件变更卡片。

Project 场景使用运行时 workspace 引用：

- Wework 发送 workspace key 或显式选择的 `deviceId + workspacePath`，不发送中心库 `projectId`。
- Backend 根据当前用户在线设备返回的 runtime workspace 列表校验该工作区，解析出可信的 `deviceId + workspacePath`。
- 如果没有选中项目，Wework 使用本地设备的空工作区上下文进入普通对话；该状态不带远程 IP，也不把 `projectId=0` 写进 URL。
- 新建空白项目会在目标设备的 `~/Documents` 下创建目录；如果目录名已存在，前端必须要求用户重命名，而不是把已有目录当成项目使用。

空项目也由运行时持有。Wework 创建或选择目录后调用 workspace open/register 流程，让 executor 把这个工作区纳入 `runtime.tasks.list` 的项目分组；即使目录下还没有 LocalTask 或 Codex 会话，也应显示为项目。这个流程不写 `TaskResource`、`Subtask`，也不写 Backend `projects` 表。

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

## Project 与 Conversation

Wework 不再显示“未映射工作区”。executor 返回的线程必须能归入“项目”或“对话”：

- `workspaceKind: chat` 的任务展示在“对话”区。
- 其他任务按工作区名称展示为“项目”。
- “对话”区即使为空也始终显示，并且支持像“项目”区一样折叠和展开。

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

新对话和未选择项目的入口使用根路径或普通会话路径，不使用 `projectId=0` 这类占位参数。项目选择状态由 runtime workspace 引用和当前会话上下文恢复。

## 兼容性

Wegent 原生 Task/Subtask 流程仍保留给现有聊天、共享任务和历史 task URL。Wework sidebar、移动端 drawer、项目下任务展示和新任务创建路径使用 runtime work API，不再依赖 DB task list 或 Backend `projects` 表。
