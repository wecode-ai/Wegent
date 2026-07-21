---
sidebar_position: 24
---

# Codex 左侧栏状态一致性

Wework 桌面端复用 Codex App 的侧栏状态语义。项目和实时任务内容由 Codex app-server 提供，侧栏元数据由设备对应 `CODEX_HOME` 下的 `.codex-global-state.json` 提供。远程设备在线时，Wework 还会在本机保存任务列表摘要，用于设备离线后的启动恢复。

## 状态所有权

| 数据                     | 唯一来源                               | 说明                                                                      |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| 项目名称、根目录和类型   | Codex global state                     | 支持传统目录项目、`local-projects` 多目录项目和 `remote-projects`         |
| 项目顺序、置顶和外观     | Codex global state                     | 使用 `project-order`、`pinned-project-ids`、`project-appearances`         |
| 任务标题、时间和运行状态 | Codex app-server + Wework 远程摘要缓存 | Wework 不缓存任务正文；离线缓存中的运行状态始终为停止                     |
| 任务归属、顺序和置顶     | Codex global state                     | 使用 assignment、workspace hint、项目内 thread order 和 pinned thread IDs |
| 展开状态和滚动偏好       | Wework localStorage                    | 仅保存不影响 Codex 的纯 UI 偏好                                           |

项目的 UI 标识由“状态所属设备 + project key”组成。这样，不同设备上相同路径的项目不会被错误合并。

任务的 UI 标识由“状态所属设备 + task ID”组成。实时列表刷新只按这个标识合并任务；标题、工作区路径和运行时类型都不是身份字段。不同任务可以具有相同标题，例如连续发送两个只有附件且没有文本的任务，因此前端和 Executor 都不能用这些展示字段推断任务重复。

## 项目模型

Executor 将以下三类数据合并为统一项目列表：

1. `electron-saved-workspace-roots` 与 `electron-workspace-root-labels` 表示传统单目录项目。
2. `local-projects` 与 `project-writable-roots` 表示新版本地多目录项目。
3. `remote-projects` 表示远程主机上的项目。

任务归组依次采用：`projectless-thread-ids` 排除、`thread-project-assignments` 显式归属、`thread-workspace-root-hints` 提示、最长项目根路径匹配。显式信息始终优先于路径推断。

## 写入与并发

Wework 只发送语义操作，例如“把项目 A 放到 B 前”“置顶 thread T”，不从前端整份覆盖 JSON。Executor 在每次操作时读取最新状态并计算数组。

Codex App 未运行时，Executor 在同目录写临时文件、刷盘后原子替换 global state。Codex App 运行时，操作先进入 JSONL oplog；读取时将磁盘状态和待写操作叠加，因此 UI 立即可见。Codex 退出后，Executor 把操作合并到最新磁盘状态。所有写入都保留 Wework 不认识的字段。

本地项目由本地 Executor 修改本机 `CODEX_HOME`；远程项目由目标设备的 Executor 修改该设备的 `CODEX_HOME`。Backend 不持久化这部分状态。

## 远程任务离线恢复

云端或远程设备的任务列表同步成功后，Wework 按当前用户在本机 `localStorage` 保存字段白名单内的摘要，包括任务 ID、标题、更新时间、工作区路径、仓库和分支提示以及侧栏排序信息。缓存不包含会话正文、工具调用、运行句柄、模型配置或父子任务树；完整详情仍只存在于远程设备。

启动时，缓存摘要作为过期数据与本地 Codex 项目描述合并。远程设备不可用时，项目、上次记录的 IP 和任务摘要仍会显示，状态点为灰色；任务行不能打开，也不能置顶、重命名、订阅通知或归档。设备重新在线后，实时列表恢复为权威数据，并更新或清理缓存。设备发现或任务列表同步失败时保留旧摘要，避免暂时的网络错误清空侧栏。

“远程设备不可用”和“用户主动断开云连接”是两个不同状态。只要 Wework 仍保持云连接，离线设备对应的远程项目继续按上述规则显示。用户主动断开云连接时，Wework 暂时从侧栏隐藏远程项目、远程任务和远程聊天，但不会删除本地摘要缓存或 Codex global state 中的 `remote-projects`。重新连接后，侧栏先从缓存恢复原远程项目，再由实时设备和任务列表更新；本地项目始终不受影响。

## 交互边界

- “云端工作”显示“可用”时，点击整行会打开“连接”设置，与行尾设置按钮的行为一致。
- 点击项目只展开或收起任务，不改变中间内容区。
- 点击任务或新建项目任务才改变主内容。
- 项目、置顶项目、置顶任务和项目内任务支持语义化拖拽排序。
- 任务只允许在同一项目内排序，不提供跨项目放置目标，也不通过拖拽修改 `thread-project-assignments`。
- 项目和任务的省略号菜单与右键菜单使用同一动作集合。
