---
sidebar_position: 1
---

# Wework 单轮文件变更

## 背景

Wework 当前通过 `wework -> backend -> executor/device` 执行 Codex 和 Claude
代码任务，但 AI 消息只展示文本与工具调用。Codex 和 Claude 原生客户端会在一次
问答完成后展示该轮修改的文件、增删行数和 Diff，Wework 尚未保留和呈现这些信息。

本功能必须以一次用户消息及其对应 AI 回答为统计边界。工作区相对 `HEAD` 的累计
Diff 不满足要求，因为它会混入用户原有修改和其他问答轮次的修改。

## 目标

- 每个成功完成的代码执行轮次生成独立的文件变更集。
- AI 消息底部展示文件数量、总增删行数和逐文件统计。
- 用户可以在线审核该轮完整 Diff。
- 用户可以在无冲突时只撤销该轮变更。
- Codex 和 Claude 使用一致的数据格式和前端行为。
- 页面刷新后仍可展示变更摘要和撤销状态。

## 范围

首版包含：

- Wework Git 项目工作区。
- Codex 和 ClaudeCode executor。
- 新建、修改、删除、重命名及二进制文件变更。
- 桌面端和移动端变更摘要、审核和撤销交互。
- 在线设备上的 Diff artifact 读取与反向应用。

首版不包含：

- 非 Git 工作区。
- 设备离线时审核完整 Diff。
- 强制覆盖冲突或连带撤销后续轮次。
- 恢复 Claude/Codex 对话上下文本身。

## SDK 能力与统一策略

Codex SDK 会发送 `turn/diff/updated` 和 `fileChange` item，能够提供单轮 unified
diff、文件路径和变更类型，但当前 SDK 没有公开的文件 rewind API。

Claude Agent SDK 支持 `enable_file_checkpointing=True` 和
`rewind_files(user_message_id)`，但只追踪 `Write`、`Edit` 和 `NotebookEdit`
工具产生的修改。Bash、脚本和格式化器产生的修改不会被 checkpoint 覆盖，SDK
也不直接提供适合 Wework 持久化的完整单轮文件统计。

因此两种 SDK 的原生能力只作为增强信息。最终文件变更集统一由 executor 在工作区
执行前后生成 Git 快照并比较，确保覆盖所有进程产生的文件修改。

## 轮次边界

一个文件变更集绑定一个 assistant `Subtask`：

1. executor 收到该 subtask 的执行请求。
2. 在向 Codex 或 Claude 发送本轮用户输入前捕获 `before` 快照。
3. 执行完整 agent turn，包括工具调用、脚本、格式化和测试。
4. turn 成功结束后捕获 `after` 快照。
5. 计算 `before -> after` 的独立 patch、逐文件统计和总计。
6. 将摘要随 executor 完成结果返回 Backend，并把完整 patch 写入设备 artifact。

暂停、取消或失败的轮次不生成可撤销的完整变更集。实现可以记录诊断日志，但前端
不展示可能不完整的变更卡片。

## Git 快照设计

### 要求

快照必须：

- 保留执行前已有的 tracked、staged、unstaged 和 untracked 状态。
- 不修改用户真实 Git index。
- 不创建用户可见 commit、branch 或 stash。
- 不包含 ignored 文件。
- 能表示无 `HEAD` 的新仓库。
- 能生成可逆的 binary patch。

### 实现方式

executor 使用临时 Git index 构造树对象：

1. 创建轮次专用临时目录和临时 index。
2. 如果仓库存在 `HEAD`，以 `HEAD` tree 初始化临时 index；否则使用空 index。
3. 将当前工作区中所有未忽略文件加入临时 index。
4. 用 `git write-tree` 生成 `before_tree`。
5. turn 完成后用新的临时 index重复上述过程，生成 `after_tree`。
6. 使用 `git diff --binary --find-renames before_tree after_tree` 生成 patch。
7. 使用 `--numstat` 和 `--name-status` 生成逐文件摘要。

临时 index 通过 `GIT_INDEX_FILE` 隔离，不能影响用户的 staged 状态。执行前已经存在
的脏修改同时出现在两棵树中，因此不会被计入本轮变更。

## Artifact 存储

完整 patch 保存在执行设备的 Wegent 任务 artifact 目录，不放入数据库。路径必须由
executor 生成和解析，Backend 与 Wework 不能提交任意设备文件路径。

推荐逻辑标识：

```text
turn-file-changes/{task_id}/{subtask_id}/changes.patch.gz
```

artifact 内容为 gzip 压缩的 Git binary patch。设备侧同时保存最小 metadata 文件，
用于校验 patch 版本、task、subtask、workspace 和校验和。

设备清理任务应将这些 artifact 与任务生命周期关联。只要数据库摘要仍指向 artifact，
清理逻辑不得提前删除；artifact 不存在时 Backend 返回明确的不可用状态。

## 数据模型

不新增数据库表。文件变更摘要合并到 assistant `Subtask.result`：

```json
{
  "value": "AI response",
  "blocks": [],
  "file_changes": {
    "version": 1,
    "status": "active",
    "artifact_id": "turn-file-changes/6268/12345",
    "device_id": "device-id",
    "workspace_path": "/workspace/project",
    "file_count": 6,
    "additions": 107,
    "deletions": 121,
    "files": [
      {
        "old_path": "src/old.ts",
        "path": "src/new.ts",
        "change_type": "renamed",
        "additions": 3,
        "deletions": 1,
        "binary": false
      }
    ],
    "reverted_at": null
  }
}
```

`artifact_id` 是受控逻辑 ID，不是客户端可修改的绝对路径。`workspace_path` 用于校验
该 artifact 仍对应原工作区，不作为请求参数接受。

状态：

- `active`：变更仍在工作区，可审核和尝试撤销。
- `reverted`：该轮 patch 已成功反向应用。
- `conflicted`：最近一次撤销检查发现冲突，工作区未被修改。
- `artifact_missing`：摘要存在但设备 artifact 已不存在。

新的撤销尝试可以将 `conflicted` 恢复为 `reverted`，因为用户可能先手动解决冲突。

## Executor 到 Backend 协议

统一 Responses emitter 的完成结果新增可选 `file_changes` 字段。executor 在调用
`done()` 前完成 artifact 写入，完成事件只传输摘要和 `artifact_id`，不传输完整 patch。

Backend 在现有 completed result 合并流程中保留 `file_changes`，写入
`Subtask.result`，并通过 `chat:done.result.file_changes` 发送给在线 Wework 客户端。
历史任务加载继续从同一 `Subtask.result` 恢复，无需额外列表查询。

没有变更、非 Git 工作区或不支持的 shell 不发送 `file_changes`。

## Backend API 与设备 RPC

### 审核

新增按 subtask 读取 Diff 的 Backend API：

```text
GET /api/tasks/{task_id}/subtasks/{subtask_id}/file-changes/diff
```

Backend 校验：

- 当前用户拥有 task。
- subtask 属于 task 且包含有效 `file_changes`。
- 当前项目仍绑定摘要记录的设备和工作区。
- 设备在线。

Backend 使用受控设备命令读取并解压 artifact，校验 metadata 和 checksum，然后返回
完整 unified diff。设备离线或 artifact 缺失时返回可区分的错误码。

### 撤销

新增：

```text
POST /api/tasks/{task_id}/subtasks/{subtask_id}/file-changes/revert
```

设备侧原子流程：

1. 读取并校验 artifact。
2. 在原工作区执行 `git apply --reverse --check`。
3. 检查失败时不修改文件，返回冲突详情。
4. 检查成功后执行 `git apply --reverse`。
5. 返回新的工作区状态和成功结果。

Backend 只在实际应用成功后将状态改为 `reverted`。冲突时设置为 `conflicted`，但保留
artifact 供后续审核和重试。重复撤销 `reverted` 记录返回幂等成功。

所有设备命令使用预注册 command key 和服务端解析的 artifact ID，禁止客户端传递
任意 shell 命令或文件路径。

## Wework UI

AI 消息底部增加文件变更卡片：

- 标题显示“已编辑 N 个文件”。
- 显示总计 `+additions -deletions`。
- 每行显示相对路径、该文件新增和删除行数。
- 默认显示前三个文件，可展开或收起其余文件。
- 二进制文件显示“二进制文件”，不伪造行数。
- “审核”打开逐文件 Diff 面板。
- “撤销”弹出确认对话框，然后调用撤销 API。

状态行为：

- `active` 且设备在线：审核和撤销可用。
- 设备离线：保留摘要，两个操作禁用并说明原因。
- `reverted`：显示“已撤销”，不再提供撤销。
- `conflicted`：显示冲突提示，审核仍可用，允许用户处理工作区后重试。
- artifact 缺失：保留摘要，操作不可用。

审核面板按文件分组展示 unified diff，支持新增、删除、重命名和二进制状态。首版不
提供逐 hunk 接受或拒绝。

桌面和移动端复用数据组件；当交互和布局差异超过现有响应式组件承载范围时，分别
提供桌面和移动容器。所有按钮、展开控件和确认操作添加稳定的 `data-testid`。

## 并发与一致性

- 同一工作区同一时间只允许一个可修改代码的 turn，否则前后快照无法可靠归因。
- 如果现有调度允许同一工作区并发执行，快照模块必须获取 workspace 级执行锁。
- 审核读取 artifact，不读取当前 `git diff`，因此历史展示不会随工作区变化。
- 撤销必须在设备端连续完成 check 和 apply，避免两次 RPC 之间出现竞争修改。
- 撤销旧轮次时若后续轮次修改了相同内容，反向检查失败并拒绝覆盖。

## 安全

- artifact ID 必须限制在 Wegent 管理目录内，并防止路径穿越。
- patch 解压设置大小上限，防止压缩炸弹。
- Diff API 对文本大小设置响应上限；超限时返回下载或截断提示，不影响撤销。
- 日志不记录完整 patch 内容。
- Backend 必须校验 task、subtask、user、device 和 workspace 的归属关系。

## 测试

### Executor

- 执行前已有 staged、unstaged 和 untracked 修改不计入本轮。
- 连续两轮修改同一文件时分别生成正确 patch。
- 覆盖新建、修改、删除、重命名、无 `HEAD` 仓库和二进制文件。
- Bash、格式化器和 SDK 文件工具产生的修改均被捕获。
- 临时 index 不改变用户真实 staged 状态。
- artifact checksum、压缩和路径校验。

### Backend

- completed result 正确合并并持久化 `file_changes`。
- `chat:done` 和历史任务返回相同摘要。
- 审核和撤销鉴权。
- 设备离线、artifact 缺失、冲突和重复撤销。
- 撤销状态更新不会覆盖 `Subtask.result` 中已有 `value` 和 `blocks`。

### Wework

- 卡片总计、前三项、展开和收起。
- 审核面板逐文件渲染。
- 撤销确认、成功、冲突和错误状态。
- 设备离线时摘要可见且操作禁用。
- 页面刷新后从历史 result 恢复。
- 桌面和移动端交互测试。

### 集成

- Claude 通过 Edit 和 Bash 混合修改后统计、审核和撤销正确。
- Codex 原生 turn diff 与最终快照结果一致时正常展示。
- 后续轮次修改同一 hunk 后，撤销旧轮次应无副作用地返回冲突。

## 文档

实现完成后在 `docs/zh/` 先补充用户使用说明和限制，再同步
`docs/en/`。文档必须明确设备离线不能审核或撤销，以及 Claude SDK checkpoint
不是 Wegent 撤销功能的唯一数据来源。
