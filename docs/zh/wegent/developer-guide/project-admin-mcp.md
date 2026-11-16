---
sidebar_position: 57
---

# 项目配置管理 MCP

项目维护者可以通过 `wework_space` 读取、预检和更新项目配置。MCP 与页面复用
`CloudProjectService` 和现有权限服务；执行器原生 MCP 转发同一配置接口，不依赖桌面窗口。

## 能力发现

先调用 `get_project_admin_capabilities`，传入目标 `space_id`。目录返回当前账号可调用的
操作及其 `inputSchema`、`outputSchema`、权限、`supportsDryRun` 和可用性；不可用操作
位于 `unavailableCapabilities`，附带稳定的 `reason_code`。

目录覆盖项目详情、标签、看板视图、状态、协作策略、工作流、自动化、成员和助理花名册。
`get_project_config` 返回安全配置、`projectVersion` 和当前 `revision`。成员权限角色与
职能职责分别表示；助理配置仅返回可见的公共花名册与资源绑定，不返回私人提示词、记忆或凭据。

## 预检与写入

使用目录中的类型化工具提交配置，包含读取所得的 `version`。需要可靠重试时，提供
`operation_id` 或 `idempotency_key`。`dry_run: true` 返回预期差异并回滚整个事务，不增加
项目版本、审计或执行取消记录。

实际写入返回 `before`、`after`、`diff`、`projectVersion`、`revision`、`actor`、
`operationId`、`appliedAt` 和 `auditId`。同一操作标识与相同请求重试返回首次结果；不同
请求复用标识返回 `idempotency_conflict`。过期版本返回 HTTP 409 和 `version_conflict`。
写入后再次调用读取工具复核持久化结果。

即使之后已有其他写入，重试仍复原首次公开写结果的配置、版本和时间，读取则返回当前状态。
每次重试先检查当前权限；响应中的有效权限、能力可用性、提供方与执行配置始终取当前值，
审计记录不缓存历史授权、凭据或私密执行配置。

看板视图沿用页面的 `BoardViews` 对象：`schema_version`、`default_view_id` 和 `views`。
列使用 `type: status | tag | unmatched` 与 `value`；筛选使用 `filter`，每列排序使用
`sorts`。不接受未声明的任意配置字段；具体约束以能力目录发布的 schema 为准。

标签更名或删除使用 `tag_change: {source, target}`，其中 `target: null` 表示删除。
服务端在同一事务中更新项目标签、Issue 引用、保存视图列、筛选和排序；无法安全处理的
引用使整个操作失败。正在运行的 Issue 保留策略与工作流快照；新策略返回生效范围和快照规则。

## 权限、错误与回滚

配置读取要求项目 Viewer，写入要求 Maintainer 或更高权限，并继续校验成员、智能体和
资源绑定的原有权限。常见原因码包括 `permission_denied`、`version_conflict`、
`invalid_config`、`unsupported_field`、`unsupported_capability` 和
`partial_reference_conflict`。能力缺失或权限错误不会触发桌面操作或权限绕过。

`WEWORK_PROJECT_ADMIN_TOOLS_V1` 控制 `wework.projectAdminTools.v1`。关闭时，目录隐藏
新增写能力并保留读取和页面管理；已经持久化的配置保持可读。回滚不删除项目配置。
