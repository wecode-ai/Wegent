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

Rust executor 为运行时任务保留设备侧 JSON LocalTask 索引：

```text
$WEGENT_EXECUTOR_HOME/runtime-work/index.json
```

Codex 任务通过 `codex app-server --stdio` 的 JSON-RPC 协议发现和控制。executor 会在本地索引中保存 Wegent 侧 `localTaskId`、工作区、标题、状态以及真实 Codex `threadId` 的关联，便于 app 模式创建任务后重启仍能恢复映射；完整 transcript 仍以 Codex app-server `thread/read` 返回的会话 metadata 和本机 rollout JSONL 为准，不同步到中心数据库。

`localTaskId` 是 Wegent 侧本地任务身份，不等同于底层 runtime 的 provider 会话 id。前端、Backend 和 executor 需要传递 provider 会话定位信息时必须使用 opaque `runtimeHandle`，例如 Codex `threadId`、Claude Code `sessionId` 或 OpenCode `sessionId`，也可以使用明确的 `providerSessionId`。`runtime.tasks.transcript` 不能在缺少 LocalTask 索引映射或 `runtimeHandle` 时把 `localTaskId` 当成 provider 会话 id 读取；这种仍在创建中的 optimistic 任务应先返回空本地 transcript，等待 create/link 完成后再读取真实运行时会话。

## 列表刷新

任务列表由 Wework 在启动、显式刷新或设备状态变化时请求，不再由固定 interval 轮询触发。

1. Wework 请求 `GET /api/runtime-work`。
2. Backend 读取当前用户在线设备列表，并通过设备 WebSocket RPC 调用 `runtime.tasks.list`。
3. executor 通过常驻 Codex app-server 的 `thread/list` 刷新本机 Codex 线程，并合并设备侧 JSON LocalTask 索引。
4. executor 在返回值中携带 `workspaceKind`、工作区路径、任务标题、更新时间和设备状态。
5. Backend 做轻量聚合后返回给 Wework，不再读取或匹配 Backend `projects` 表。
6. Wework 根据 runtime work 响应展示 Project 和 Conversation；每个 LocalTask 的打开和通知身份仍是 `deviceId + localTaskId`。

`runtime.tasks.list` 的响应有两层工作区语义。外层 workspace 表示侧栏 Project 分组，Codex git worktree 任务应归并到共同的仓库根目录；内层 LocalTask 表示任务实际运行目录，必须保留自己的 `workspacePath`。如果该目录是 git worktree，LocalTask 需要携带 `workspaceKind: worktree` 和 `worktreeId`，侧栏 worktree 图标、底部终端 cwd 和右侧工具目录都只从 LocalTask 字段判断。不能因为某个 LocalTask 是 worktree 就把父 workspace 标记为 worktree，也不能把 LocalTask 路径覆盖成父 workspace 路径。

executor 不主动向 Backend 轮询或推送任务列表。离线设备不会贡献 LocalTask；Wework 可以显示映射目录离线，但不会从中心库缓存本地任务。

如果只有一个设备，Wework 不在项目名后显示设备 IP；如果有多个设备，本地设备不显示 IP，远端在线设备显示可用的非 loopback runtime transfer host 或客户端 IP，并配绿色在线点。远程项目和远程主机选择器的主显示文本也优先使用这个 IP/host；设备 id 只是缺少网络地址时的技术回退。

## 搜索

Wework 使用运行时搜索能力查找设备上的本地任务：

```text
POST /api/runtime-work/search
```

Backend 只向当前用户在线或 busy 的设备 fan-out `runtime.tasks.search` RPC，不读取中心库 `TaskResource`、`Subtask` 或历史缓存。executor 在本机任务标题和 transcript 中搜索，并返回匹配片段、消息元数据、更新时间、设备名、工作区路径和临时任务地址。对于 Codex 历史线程，临时任务地址必须携带 `runtimeHandle.threadId`，这样点击搜索结果后可以直接通过 transcript RPC 读取原始会话，而不依赖本地任务索引中已经存在对应 link。

搜索结果按 `updatedAt` 倒序聚合，并受请求 `limit` 限制。`includeArchived` 传给 executor 决定是否包含已归档 LocalTask。请求携带 `projectId` 时，Backend 会根据工作区路径推导 Project，并只返回该 Project 下的搜索结果；`workspaceKind: chat` 的 Conversation 结果没有 Project 归属。

前端搜索框打开结果里的运行时地址，随后仍通过最新 runtime work 列表恢复工作区上下文。搜索框只在内存中保留最近查询结果，用于避免同一会话内重复输入触发相同 RPC；缓存结果不写入 Backend，也不替代 executor 侧的 transcript 读取。

## 打开和继续任务

打开 LocalTask 时，Wework 调用 Backend：

```text
POST /api/runtime-work/transcript
```

Backend 将 `deviceId + localTaskId` 转发给对应设备的 `runtime.tasks.transcript`。原生 Codex 任务通过 Codex session path 或 session 文件发现定位；非 Codex/导入类任务可以使用 `workspacePath` 作为本地索引查找提示，或者通过本机 LocalTask 索引按 `localTaskId` 定位。executor 读取原生运行时 transcript，并返回标准化消息。

### Codex 会话读取路径与性能

Wework 的 Codex 本机会话只使用一条主读取路径，避免列表、打开、刷新各自实现一套 transcript 逻辑：

1. 列表通过常驻 Codex app-server 调用 `thread/list`，使用 `recency_at` 降序、`archived` 过滤和 `useStateDbOnly` 参数读取 thread metadata，不扫描 JSONL transcript。executor 对短时间内的重复列表请求做小窗口缓存，线程管理操作或本地任务状态变化后会失效缓存，然后合并设备侧 LocalTask 索引。
2. 首次打开调用 `thread/read`，并传 `includeTurns: false`，只拿 thread metadata 和 rollout path。executor 用这个 path 自己顺序解析一次 JSONL，生成标准化消息、tool block、thinking block、文件变更和 raw rollout turns，并把这些结果连同文件长度/mtime 签名放进内存 cache。
3. 已加载后的切换不再访问 Codex app-server，也不重新读文件。executor 从内存 cache 取完整消息数组，然后用请求里的 `limit`/`beforeCursor` 做分页返回。
4. 切换时需要获取最新数据时，executor 先读取当前 rollout 文件签名。如果文件只发生 append，就从上次文件长度开始读取新增字节，把新增事件合并到缓存的 rollout turns，并只从受影响的第一个 turn 重新生成消息，按 `turnId` 替换缓存尾部。这样 tool item、thinking、运行状态和最新文本都来自同一个 append 结果，不需要额外 fallback。
5. 只有文件被截断、mtime 变化但长度不变、或老缓存没有 raw turns 时，才丢弃缓存重新执行一次首次打开路径。这是文件非 append 变化的恢复路径，不承载正常功能。

列表、读取和线程管理共享同一个常驻 Codex app-server 连接，避免每次 RPC 都重新启动子进程。没有使用 Codex app-server `thread/turns/list` 做长会话分页，因为当前 Codex 实现仍会在每次请求时 replay 整个 rollout 文件；对 Wework 来说它和全量读取成本相同，却不能复用 executor 已经标准化好的 tool/message cache。打开时也不请求 `includeTurns: true`，因为大 transcript 会把完整 turns 通过 app-server 再序列化一次，反而增加 IPC 和前端压力。

可用下面的手工 benchmark 复测本机 rollout：

```bash
cd executor
WEGENT_MANUAL_ROLLOUT=/path/to/rollout.jsonl \
WEGENT_MANUAL_APPEND=1 \
cargo test --test manual_runtime_perf -- --ignored --nocapture
```

当前本机实测结果：

| 样本                             | 文件大小 |  列表 | 首次打开 | 已加载切换 | append 刷新 |
| -------------------------------- | -------- | ----: | -------: | ---------: | ----------: |
| “修复进行中任务未显示 tool 调用” | 约 61 MB | 13 ms |   2.09 s |      33 ms |       53 ms |

因此当前目标达到列表 1 秒以内、首次打开 3 秒以内、已加载切换和获取最新数据 500 ms 以内。更大的极端历史首次冷解析仍受 JSONL 文件大小限制，但加载后切换和 append 刷新不再随历史总长度增长。

继续 LocalTask 时，Wework 调用：

```text
POST /api/runtime-work/send
```

Backend 转发 `runtime.tasks.send`。executor 根据本地 LocalTask 的 opaque runtime handle 继续运行时会话。Codex 任务使用保存的 `threadId` 调用 app-server `thread/resume`，再通过 `turn/start` 发送本轮输入；消息和状态以 Codex 自己的 thread transcript 为准，executor JSON 索引只保存任务链接元数据。流式 Responses 事件携带当前 LocalTask 的 `local_task_id`、本轮 `task_id` 和 `subtask_id`；Wework 入口层把本地任务映射成统一的 task 身份，把 `subtask_id` 当作本轮 turn 身份，后续消息 reducer 不再使用单独的 `message_id`。这些事件不携带 `workspacePath`。

每一次继续 LocalTask 的请求都必须携带当前模型选择。Wework 的模型选择器是本轮发送的事实来源：用户本轮选择哪个模型，`runtime.tasks.send` 就传哪个 `modelId`、`modelType` 和模型选项。executor 不从上一次请求恢复模型，也不缓存模型选择；如果请求没有完整 `executionRequest` 且没有 `modelId`，executor 必须返回 `bad_request`，而不是回退到默认模型。打包本地 app 的 `createLocalAppServices()` 是本机 Codex 模型名规范化的唯一边界：UI 可以展示 `codex-gpt-5.5`，但发送到 Codex app-server 前必须统一转换成真实模型 id `gpt-5.5`。新建任务和继续任务都必须复用同一套规范化逻辑。

如果当前 LocalTask 仍在回复，Wework 会把新的用户输入放入本地队列，而不是并发调用 `runtime.tasks.send`。用户可以取消队列中的消息；也可以在队列面板中选择“暂停当前回复并发送”，这会先调用：

```text
POST /api/runtime-work/cancel
```

Backend 将 `deviceId + localTaskId` 转发为 `runtime.tasks.cancel`。Rust executor 的 Codex app-server 路径当前不会跨进程中断正在运行的 turn，因此 app 模式会返回 `accepted: false`，前端应保留队列状态或等待当前 turn 结束。后续如果实现 `turn/interrupt`，仍必须只使用 `deviceId + localTaskId` 定位任务，`workspacePath` 只是设备目录上下文。

如果当前 Codex LocalTask 正在回复，Wework 还可以把队列中的用户输入作为原生引导发送：

```text
POST /api/runtime-work/guidance
```

Backend 只做用户、设备和 LocalTask 归属校验，然后把 `deviceId + localTaskId`、用户文本和前端生成的 `clientGuidanceId` 转发为设备 RPC `runtime.tasks.guidance`。executor 必须定位正在运行的 Codex turn，并通过 Codex app-server 原生引导能力把用户文本追加到当前 turn；如果没有可引导的活跃 turn，应返回 `no_active_turn`，前端再把这条消息按普通 follow-up 发送。`runtime.tasks.guidance` 不创建新的中心库任务或子任务，也不把 `workspacePath` 当成任务身份。

前端发送引导时必须立即把本地用户消息插入到当前 streaming assistant 的位置，而不是等待 `runtime.tasks.guidance` 返回。插入时把当前 assistant 拆成“引导前”和“引导后”两个消息：引导前消息冻结为 done，引导后消息继续保留原 `subtaskId` 接收后续 stream。后续 `chat:chunk`/`chat:done` 仍可能带完整文本，因此前端要按拆分时记录的文本前缀裁剪后续内容，确保流式显示和刷新后的 transcript 顺序一致。

用户也可以从 composer 的上下文用量入口手动压缩本机 Codex LocalTask：

```text
runtime.tasks.compact
```

Wework App 只通过本机 executor IPC 调用 `runtime.tasks.compact`，不提供 Backend HTTP 接口。executor 必须先用 LocalTask 的 opaque `runtimeHandle.threadId` 调用 Codex app-server `thread/resume`，再调用 `thread/compact/start`，不能把 `/compact` 当作普通用户消息发送。手动压缩使用独立的运行时 subtask id：`<localTaskId>-context-compact`，这样 UI 可以把 `context_compaction` tool block 渲染成一条独立完成消息，并且不会结束正在回复的普通 assistant turn。

如果当前 pane 仍在回复，Wework 应阻止手动压缩并提示用户等待当前回复结束。Codex 自动触发的上下文压缩仍然属于当前 turn 的 subtask；前端只能显示对应 `context_compaction` block，不能因为这个 block 完成就补发 `assistant_done` 或结算当前回复。

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
POST /api/runtime-work/archived-conversations/cleanup-preview
POST /api/runtime-work/archived-conversations/cleanup
```

executor 对原生 Codex 会话通过 app-server `thread/archive`、`thread/unarchive` 和 `thread/delete` 执行归档、恢复和删除；重命名使用 `thread/name/set`。归档列表响应来自 state DB `threads.archived` 过滤结果并合并 JSON LocalTask 索引，标准化 `id`、`localTaskId`、`threadId`、标题、Project 名称、工作区路径、设备、来源和时间字段，并按 Project 汇总计数。刚执行归档/恢复时，如果 state DB 尚未同步，设备侧 LocalTask 索引中的本地覆盖态会先参与列表，避免 UI 短暂消失。Project 分组必须使用 Project 主目录或 `groupWorkspacePath`，不能把同一 Project 下的不同 worktree 当成不同 Project。

如果 Codex `thread/list` 返回了 state DB 中仍存在但 rollout 文件已经无法定位的脏线程，`thread/archive` 会返回 `no rollout found for thread id ...`。executor 只在这个明确错误下把该项按清理路径处理：调用 Codex `thread/delete` 删除残留线程记录，并在本地写入有 TTL 和数量上限的删除标记，让后续列表不再展示这条不可操作记录；它不会把这类脏线程伪造成已归档会话。

删除归档会话采用两阶段策略。前台 `delete` 和 `delete-bulk` 先在 executor 本地索引写入 tombstone，列表立即隐藏对应项；真正的 Codex `thread/delete`、LocalTask 索引删除、worktree/附件/日志文件清理由 executor 后台单 worker 逐条执行。后台 worker 必须等待当前 app-server `thread/delete` 真正返回后再处理下一条；如果删除变慢，只记录慢操作日志，不能通过客户端 timeout 继续堆叠新的 `thread/delete`，否则会压住 Codex thread store 并让归档列表刷新长期等待。前端批量删除按小批次提交，并把进度保存在页面外状态中，用户离开再进入设置页仍能看到当前删除进度。

`cleanup-preview` 和 `cleanup` 只面向已归档 LocalTask 的残留文件，包括 executor 管理的 Git worktree 目录、LocalTask 记录、会话日志、运行时 handle 中记录的本地附件，以及本机附件草稿路径。清理目标必须从归档项的 `deviceId + workspacePath + localTaskId + threadId/runtimeHandle` 推导并做路径安全校验，只能删除 executor 管理目录、standalone chat 目录或本地附件草稿目录下的文件；普通 Project 根目录、未归档会话、运行中任务和未被前端提交的归档项不能被清理。

如果被归档的 LocalTask 使用 Git worktree，Wework 会先在该任务的 `deviceId + workspacePath` 上执行 `git status --porcelain`。工作树干净时，归档成功后会通过设备命令执行 `git worktree remove --force` 删除对应 worktree 目录；存在未提交代码时，前端先提示用户，默认不归档也不删除目录。用户选择强制归档后，Wework 会继续归档并强制删除该 worktree，因此未提交变更不会被保留。这个清理只针对 runtime LocalTask 的 worktree，不改变 Project 主工作区。

在打包 Wework App 的 `local-first` 模式下，粘贴或选择的文件会保存到 executor home 的附件草稿目录（配置 `WEGENT_EXECUTOR_HOME` 时为 `$WEGENT_EXECUTOR_HOME/workspace/attachments/draft`，未配置时为 `~/.wegent-executor/workspace/attachments/draft`），并作为本机 `attachments` 通过 executor IPC 发送，不使用 Backend `attachmentIds`。图片附件会保留 `local_preview_url`，发送后的消息可以通过 Tauri asset protocol 立即预览，Codex 也会收到同一路径对应的 `localImage` 输入。文本类本机附件不会全文注入上下文；executor 只注入前 10 行或 4 KiB（先到为准）的有界预览，并同时给出 `Local File Path`，需要完整内容时由 Codex 读取本机文件。Wework 会把 `text_length` 和 `text_preview` 保存在本机附件 metadata 中，刷新后仍能渲染紧凑的文本预览附件；在 Tauri App 中点击该附件会通过 `open_local_file` 命令打开原始本机文件。连接 Backend 并使用上传附件时，刷新后仍以持久化附件 ID 为准。

消息渲染时，如果消息已经带有持久化图片附件，Wework 优先展示附件预览，并忽略 Codex prompt 中的本地图片文件提及，避免同时展示上传附件和临时本机路径。只有没有附件记录时，才把 Codex 本地图片提及作为本机预览兜底；如果当前环境不能通过 Tauri `convertFileSrc` 转换本机路径，或转换后的图片加载失败，前端不展示该本机路径。

executor 从原生 Codex session 发现用户消息时，会把 `local_images`、`localImages` 或 `images` 中的本机图片路径写入用户可见文本，保持刷新后仍能看到“用户提到了哪些文件”。如果这些路径在当前设备上可读、是图片 MIME 类型且不超过 5 MB，executor 会额外生成只用于 transcript 渲染的 ready 附件，并把 `local_preview_url` 写成 data URL。这个预览附件不代表 Backend 持久化附件，也不会上传或同步到中心库。

原生 Codex 任务有一个额外约束：刷新 transcript 时只信任 Codex 本身的会话记录。fork 包或 executor JSON 索引中携带的 `runtimeHandle.messages` 只是导入瞬间的快照，不能作为原生 Codex transcript 的回退来源，否则 Wework 刷新后会显示旧消息或丢失用户追问。非 SDK 原生任务仍可以使用 executor JSON 索引中的本地 transcript。

runtime transcript 中的 assistant 消息可以携带 `fileChanges` 摘要。Rust executor 的 Codex app-server 路径以 app-server 通知流作为本轮事件来源；如果后续接入 diff 通知，`runtime.tasks.create`、`runtime.tasks.send` 和 `runtime.tasks.transcript` 必须把它规范化为消息上的 `fileChanges`。这样前端无需等待下一次列表刷新，就能在当前 assistant 消息下显示本轮文件变更卡片。

Wework 展示文件变更卡片时，运行时 LocalTask 不走中心库 Task API，而是通过当前任务的 `deviceId + workspacePath` 调用设备命令 `turn_file_changes_review` 或 `turn_file_changes_revert`。这样 review 和 revert 都发生在生成该 LocalTask 的实际设备目录中。运行时本地任务可能没有中心库 `TaskResource`/`Subtask`，因此 artifact id 允许使用 `turn-file-changes/0/<subtaskId>` 这类纯数字路径；设备命令仍必须用完整正则匹配 artifact id，并从 metadata 校验 workspace 与 patch checksum，不能接受任意路径。若本地 artifact 缺失或回滚冲突，前端会把对应状态写回当前 transcript 消息，避免继续展示过期的可操作状态。

## 工作区工具上下文

Wework 打开 LocalTask 后，右侧文件、审查和终端工具使用当前 LocalTask 的设备和目录上下文解析设备与目录：

- 优先使用 `runtime.tasks.list` 返回的 LocalTask `workspacePath`，这样 Codex worktree 不会被当成另一个 Project。
- 如果 LocalTask 能映射到 Project，环境信息和审查仍带上 Project，但 Git 命令运行在 LocalTask 的实际目录。
- 如果 LocalTask 没有映射到 Project，只要设备在线且目录可访问，本地终端仍可打开；依赖 Project API 的 IDE 能力仍要求 Project 上下文。
- 对运行时 LocalTask 打开的终端必须使用当前 LocalTask 的 `deviceId + workspacePath` 启动设备级 PTY，不能回退到 Project 默认绑定设备，否则跨设备 worktree 会打开到错误机器。

底部终端面板的状态也以当前工作区工具上下文分隔。用户在 A LocalTask 打开的终端不能在切换到 B LocalTask 后复用为 B 的终端；切回 A 时才恢复 A 的终端状态。未选中 LocalTask、只选中本地 Project 时，终端 cwd 使用该 Project 的本地路径；本地 App 模式不应因为没有 Backend 连接而显示云设备提示或回退到 `$HOME`。

## 创建任务

创建新的运行时任务时，Wework 调用：

```text
POST /api/runtime-work/create
```

Backend 根据请求中的项目映射或独立设备工作区解析目标设备和目录，构造一次临时 execution request，然后调用设备 RPC `runtime.tasks.create`。这个流程不会 `db.add()` 任何 `TaskResource` 或 `Subtask`。

在打包 Wework App 的 `local-first` 模式下，创建任务不经过 Backend HTTP API。Wework 在前端本地 service 中根据选中的 `deviceId + workspacePath` 构造 executor 需要的最小 `executionRequest`，通过 Tauri command 发送到 executor sidecar 的 app IPC，再由 executor 直接执行 `runtime.tasks.create`。这个 payload 必须包含 `workspacePath`、用户消息、运行时模型配置和本地用户上下文；如果没有工作区路径，Wework 必须在调用 executor 前失败。该路径仍然只使用 app 界面和 executor 两个本机进程，不启动本地 Backend。

项目模式创建任务时，Wework 的执行工作区只有两种来源：`current_workspace` 使用项目主目录，`git_worktree` 在本机 executor 管理目录下创建独立工作树。工作树路径由设备工作区根、运行时任务 id 和项目目录名稳定拼出，不能由 UI 拼接任意路径。工作树创建请求可以携带显式 `branch`；如果没有显式分支，默认分支必须读取项目主目录的当前 Git 分支，而不是 Git 默认分支或 `HEAD` 字样。分支列表只负责展示可选分支，当前分支应排在第一位，其余分支保持 Git 返回顺序。

Wework 在调用 create 前先生成客户端侧 `localTaskId`，并在请求体中作为 `localTaskId` 传给 Backend。Backend 只把这个值转发给目标设备，不把它写入中心数据库。前端会立即用 `deviceId + localTaskId` 打开运行时 URL、展示用户消息和等待态；如果设备返回了不同的 `localTaskId`，前端再切换到设备确认的地址。这样新建任务不需要等待 Backend RPC 完成或下一次列表刷新，队列发送也会等当前等待态进入真实 assistant turn 后再继续。

运行时创建的持久化位置由具体 runtime 决定：

- Claude Code 创建 executor JSON LocalTask，并在该索引中保存 transcript 和 runtime handle。
- Codex 创建时先返回 Wegent 侧 `localTaskId`，让前端立即打开任务并接收 stream；后台通过 app-server `thread/start` 和 `turn/start` 创建真实 Codex thread 后，会把 `localTaskId -> threadId` 关联写入 JSON LocalTask 索引用于后续 send/resume。
- Codex 创建和继续时不把完整 transcript 缓存到 executor JSON 索引；executor 重启后通过 `thread/list` 和本地索引恢复任务链接，再用 `thread/read` metadata 加 rollout JSONL 读取 transcript。
- Codex 创建时仍通过 LocalTask Responses 事件通道流式返回 `response.created`、文本/tool 增量和 `response.completed`/`error`，这些事件使用 create 返回的 `localTaskId`，前端不需要等待下一次列表刷新才能显示运行中的回复。
- Codex app-server 输入支持 `input_text`、`input_image` 和 `localImage` prompt block 映射。Backend 附件 id 下载与沙箱路径重写仍和 local-first 附件分离：本地 App 模式通过 executor IPC 发送同设备附件记录，云端/Backend 路径继续使用上传后的附件 ID。
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
