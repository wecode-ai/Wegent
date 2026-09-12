---
sidebar_position: 34
---

# 协作空间存储模型

本文定义协作空间功能的数据落地方式。目标是在不建立第二套资源系统的前提下，
复用 Wegent 现有的 `kinds`、`resource_members`、`loop_items`、
`project_chat_messages` 和 `loop_item_executions`。

## 设计原则

1. 可独立定义、复用和授权的能力资源放入 `kinds`。
2. 用户或协作空间对资源的使用权放入 `resource_members`。
3. Project、Issue、评论和交付继续使用 `loop_items`。
4. Assignment 是 Issue 动态，不建立独立事实表。
5. Run 继续使用 `loop_item_executions`。
6. 关系不使用数据库外键，由服务层校验资源类型、状态和访问权限。
7. 不为尚未存在的反向查询预建专用表或索引。

## 实体存储

| 产品概念         | 存储位置               | 表达方式                                        |
| ---------------- | ---------------------- | ----------------------------------------------- |
| 协作空间         | `kinds`                | `kind = CollaborationWorkspace`                 |
| 人员成员         | `resource_members`     | User 获得 CollaborationWorkspace 权限           |
| 智能体           | `kinds`                | 复用 `kind = Team`                              |
| 执行环境         | `kinds`                | 复用 `kind = Device`                            |
| 空间可用智能体   | `resource_members`     | CollaborationWorkspace 获得 Team 使用权         |
| 空间可用执行环境 | `resource_members`     | CollaborationWorkspace 获得 Device 使用权       |
| 协作项目         | `loop_items`           | 复用 `resource_type = project`                  |
| 空间内项目       | `resource_members`     | CollaborationWorkspace 获得 CloudProject 使用权 |
| Issue            | `loop_items`           | 复用现有 Issue 类型                             |
| Issue 动态       | `loop_items`           | `resource_type = comment`                       |
| Run              | `loop_item_executions` | 复用现有执行记录                                |

代码中的新类型使用 `CollaborationWorkspace`，避免与 `tasks` 表中用于代码目录的
既有 `Workspace` CRD 混淆。中文产品界面仍显示“协作空间”。

## `kinds` 中的协作空间

协作空间使用标准 Kind 身份：

```text
user_id + kind + namespace + name
```

示例：

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "CollaborationWorkspace",
  "metadata": {
    "name": "研发协作空间",
    "namespace": "default"
  },
  "spec": {
    "description": "产品和研发协作",
    "isDefault": true
  },
  "status": {
    "state": "active",
    "version": 1
  }
}
```

空间创建者仍由 `kinds.user_id` 表示。空间成员权限必须写入
`resource_members`，不能只依赖创建者字段。

## 通用授权边

`resource_members` 统一表达“主体可以使用资源”。不增加外键，资源完整性由服务层
维护。

### 人加入空间

```text
resource_type = Workspace
resource_id   = collaboration_workspace_kind_id
entity_type   = user
entity_id     = user_id
role          = Owner | Maintainer | Developer | Reporter
status        = approved
```

### 空间使用智能体

```text
resource_type = Team
resource_id   = team_kind_id
entity_type   = workspace
entity_id     = collaboration_workspace_kind_id
role          = Owner | Developer
status        = approved
```

`Owner` 表示该 Team 作为空间资源管理，`Developer` 表示个人 Team 授权给空间使用。
`kinds.user_id` 始终记录实际创建用户，不写入 Workspace ID。

当前“从我的资源授权到空间”接口固定写入 `Developer`，不向用户暴露归属选择。
在空间内直接创建资源时，由创建服务写入 `Owner`。

### 空间使用执行环境

```text
resource_type = Device
resource_id   = device_kind_id
entity_type   = workspace
entity_id     = collaboration_workspace_kind_id
role          = Owner | Developer
status        = approved
```

执行环境使用相同规则：`Owner` 表示空间管理，`Developer` 表示个人资源共享。
当前“从我的资源授权到空间”接口同样固定写入 `Developer`。

### 项目进入空间

```text
resource_type = CloudProject
resource_id   = cloud_project_id
entity_type   = workspace
entity_id     = collaboration_workspace_kind_id
role          = Owner
status        = approved
```

一个活动 CloudProject 同一时间只能加入一个活动协作空间。数据库不建立条件唯一
约束；写入服务必须在事务内检查并拒绝第二条活动关系。

`resource_members` 已有以下访问路径：

```text
(resource_type, resource_id)
(entity_type, entity_id, status, resource_type)
```

因此既能列出空间成员，也能列出空间可用的 Project、Team 和 Device，不增加反向
关系表。

## Assignment 动态协议

Assignment 不是独立实体，而是 `LoopItemComment` 的一种结构化动态。

分配：

```json
{
  "event_type": "assignment",
  "action": "assign",
  "target_type": "human",
  "target_id": "123",
  "target_name": "李明",
  "workflow_step": "交互设计",
  "notify": true,
  "trigger": "manual"
}
```

分配给智能体：

```json
{
  "event_type": "assignment",
  "action": "assign",
  "target_type": "agent",
  "target_id": "456",
  "target_name": "Codex 产品工程师",
  "workflow_step": "代码实现",
  "notify": true,
  "trigger": "workflow"
}
```

取消分配：

```json
{
  "event_type": "assignment",
  "action": "unassign",
  "assignment_event_id": "789",
  "target_type": "agent",
  "target_id": "456",
  "workflow_step": "代码实现"
}
```

规则：

- 动态行的 `loop_item_id` 指向 Issue；
- `description` 保存用户输入的评论正文，可以为空；
- `metadata.event_type` 区分普通评论和系统动态；
- 分配事件的动态 ID 同时作为 Assignment API 的 ID；
- 当前分配列表由 Issue 的 Assignment 动态按时间归并；
- 重复活动分配由服务层在写入事务中检查；
- 分配给 Human 时产生通知；
- 分配给 Agent 时按现有策略创建 Run；
- Assignment 不授予访问权限，也不限制其他成员主动执行。

如果未来跨全部 Issue 查询当前分配出现真实性能瓶颈，可以建立可重建的投影索引。
投影不能成为新的事实来源。

## 明确不新增的结构

以下结构不进入最终模型：

```text
collaboration_workspaces
workspace_agent_bindings
workspace_execution_environments
workspace_kind_bindings
issue_assignments
loop_items.workspace_id
loop_item_executions.workspace_id
```

迁移只负责注册 `CollaborationWorkspace` 数据语义，并把已经写入上述临时结构的数据
转换为 `kinds`、`resource_members` 和 Assignment 动态。迁移完成后删除临时表和
临时字段。
