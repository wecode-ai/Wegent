---
sidebar_position: 32
---

# 云项目协作架构

> UI 与交互实现以 `/Users/hongyu9/Downloads/wework-delivery-v4-TODO.pen` 为当前 V4 设计源，不根据本文重新推导页面布局。

## 目标

云项目是多人共享的协作与存储边界。成员可以把同一个云项目关联到各自不同的本地项目，在 Wework 中执行任务，并把选定的聊天记录、文件和 Markdown 说明作为不可变交付快照提交到云端。

云项目不等同于现有 `Project`：

- `Project` 是单个用户拥有的本地执行工作区，保存设备、路径、Git 和执行配置。
- `CloudProject` 是多人共享的协作聚合根，拥有成员权限、TODO、共享文件和 MinIO 空间。
- 一个云项目可以被多个成员关联到多个本地项目。
- 一个 TODO 可以关联多个 Wework Task，但一个 Task 同时最多处理一个活跃 TODO。

## 领域关系

```text
CloudProject
├── ResourceMember(resource_type=CloudProject)
├── ShareLink(resource_type=CloudProject)
├── CloudProjectLocalBinding
│   └── Project (local execution workspace)
└── LoopItem
    ├── LoopItemTaskBinding
    │   └── TaskResource
    │       └── Project (local execution workspace)
    └── Delivery
        └── DeliveryAsset
```

## 数据归属

| 数据 | 事实来源 |
| --- | --- |
| 云项目、成员、TODO、任务关联、交付元数据 | Backend MySQL |
| 本地路径、设备、Git 和执行配置 | 现有 `projects` 与 `tasks` |
| 共享文件、Markdown、聊天记录、交付快照 | MinIO/S3 |
| AI 对云空间的访问 | Backend 鉴权后的 MCP |

MinIO 对象使用云项目公开 ID 隔离：

```text
projects/{cloud-project-public-id}/
  shared/
  loop-items/{loop-item-id}/
    deliveries/{delivery-id}/
      markdown.md
      chat.json
      manifest.json
      files/
```

交付完成后，其对象前缀不可覆盖。后续任务只能读取或复制交付物。

## 数据模型

### CloudProject

`cloud_projects` 保存共享项目本身，不保存任何本地执行配置。

```text
id, public_id, project_key, name, description
created_by_user_id, storage_prefix, next_item_number
status, version, created_at, updated_at
```

### CloudProjectLocalBinding

`cloud_project_local_bindings` 保存某个成员在某台设备上使用的本地项目。绝对路径仍保存在本地项目配置中，并且不能向其他云项目成员返回。

### LoopItem

现有 `loop_items` 作为云 TODO 使用。它通过 `cloud_project_id` 指向 `cloud_projects`，并使用 `sequence_number` 生成 `WEG-18` 形式的展示编号。

固定状态如下：

```text
inbox → pending → in_progress → in_review → completed
```

已完成 TODO 可以重新进入 `in_progress`。更新操作必须携带 `version`，服务端使用乐观锁拒绝静默覆盖。

### LoopItemTaskBinding

`loop_item_task_bindings` 表达 TODO 与实际 Wework Task 的多对多历史关系。运行时 Task 使用 `task_user_id + device_id + task_id` 标识，因为本地执行 Task 不一定存在于 Backend `tasks` 表；`backend_task_id` 仅作为可选索引。解绑使用 `unlinked_at` 软删除，以保留执行来源审计。

### Delivery

`deliveries` 和 `delivery_assets` 保存不可变快照元数据。`Delivery.source_task_binding_id` 是可空外键：云端直接完成 TODO 时为空，本地任务交付时指向已经验证的 TODO/Task 关联。

## 权限

复用 `resource_members` 和 `share_links`，新增 `CloudProject` 资源类型。

| 角色 | 读取 | 编辑 TODO/文件 | 管理成员 | 归档项目 |
| --- | --- | --- | --- | --- |
| Reporter | 是 | 否 | 否 | 否 |
| Developer | 是 | 是 | 否 | 否 |
| Maintainer | 是 | 是 | 是 | 否 |
| Owner | 是 | 是 | 是 | 是 |

所有 TODO、交付、文件和 MCP 请求都必须先解析云项目角色。无权限资源统一返回 404，避免泄露资源是否存在。

## 服务边界

```text
cloud_projects/  项目、成员和本地关联
loop_items/      TODO、状态机和 Task 关联
delivery/        不可变交付快照
cloud_files/     可变共享文件
mcp_server/tools/delivery.py  AI 按权限读取云空间与交付引用
```

Delivery 服务不负责 TODO CRUD；LoopItem 服务不直接访问 MinIO；MCP 不持有或返回 S3 凭证。

## 交付事务

1. 创建 `draft` Delivery 并写入 Markdown/聊天对象。
2. 分批上传文件，记录 SHA-256 和大小。
3. `finalize` 锁定 Delivery 与 LoopItem，验证来源 Task 仍关联当前 TODO。
4. 写入 `manifest.json`。
5. 在一个数据库事务中将 Delivery 置为 `delivered`、TODO 置为 `completed`，并更新 `current_delivery_id`。
6. 数据库提交失败时删除新写入的 manifest，草稿仍可重试。

## API

```text
/v1/cloud-projects
/v1/cloud-projects/{id}/members
/v1/cloud-projects/{id}/members/{user_id}
/v1/cloud-projects/{id}/local-bindings
/v1/cloud-projects/{id}/files
/v1/cloud-projects/{id}/folders
/v1/cloud-projects/files/{file_id}
/v1/cloud-projects/{id}/loop-items
/v1/loop-items/{id}
/v1/loop-items/{id}/tasks
/v1/loop-items/{id}/start-task
/v1/loop-items/{id}/deliveries
/v1/deliveries/{id}
/v1/cloud-work-items/my-work
/v1/runtime-tasks/loop-item
```

创建与更新使用不同端点，不提供 PUT upsert。共享文件支持创建目录、上传、重命名/移动、短期授权访问和递归删除；移动对象时先复制 MinIO 对象、提交元数据，再删除旧对象，失败时清理新对象。

Wework Composer 把云项目、目录、文件、TODO 和交付编码为 `cloud://` 原子引用。任务携带云项目上下文时注入 Delivery MCP；`resolve_cloud_reference` 在 Backend 再次鉴权并解析引用，客户端和 AI 均不接触 S3 凭证。TODO 看板在窗口可见时周期刷新，写操作仍依赖 `version` 乐观锁处理多人并发。

## 实施顺序

1. CloudProject、成员权限与本地项目关联。
2. LoopItem 迁移到 CloudProject，并补充状态机和乐观锁。
3. Task 关联与从 TODO 开启任务。
4. Delivery 的权限、来源任务和 MinIO 路径迁移。
5. 共享文件与云空间 MCP。
