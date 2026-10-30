---
sidebar_position: 36
---

# 协作模板

Wework 从“协作 → 模板”发现模板，Wegent 从能力商店的协作模板分类进入。
两个入口复用 `packages/collaboration/src/templates` 的界面、校验和配置模型，读取同一后端。

## 存储与权限

模板存储在 `kinds`，使用 `kind: Template`、`spec.category: collaboration`。
完整身份为 `user_id + namespace + name`。官方模板使用 `user_id=0`、`namespace=system`，
个人模板使用当前用户和 `namespace=default`。旧收件箱模板接口仅处理系统收件箱模板，
不能读取、修改或实例化协作模板。

发布复用资源库协议，`resource_type=template`。发布信息位于 `spec.capability`，
`marketplace_resources` 继续作为发现索引。安装复用 `resource_members` 的
`resource_type=Template` 引用，不复制模板 Kind。个人引用和有权访问的空间引用均可读取；
每次下载仍需验证当前权限。个人保存默认不发布。

## 配置接口

新接口由 Rust 实现并登记在 `backend-rs/config/routes.toml`：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/collaboration-templates` | 返回可用模板的元数据，不返回完整配置 |
| `GET /api/v1/collaboration-templates/{id}` | 验证权限后读取可移植配置 |
| `PUT /api/v1/collaboration-templates/{name}` | 保存当前用户默认命名空间中的模板 |

保存请求包含 `document` 与 `expectedRevision`。创建时 revision 为 `null`；修改需要当前
revision 和新 `spec.version`，过期 revision 返回 409。相同文档重复保存返回同一 Kind。
`spec.configurationRevision` 由服务器维护，不进入 YAML。发现列表中的模板版本始终读取
`spec.version`。更新已发布模板会更新后续使用者读取的配置；已创建项目持有独立的小组配置。

## 可移植配置

文档格式为 `agent.wecode.io/v1` 的 `Template`，`spec.resources.collaboration`
包含 `project` 和 `groups`。小组包含角色、负责人角色、工作阶段、交付物、验收条件和执行标签。
角色使用逻辑 key；导入项目时由用户绑定成员或智能体。负责人不能兼任执行角色。

YAML 导入采用白名单，拒绝未知字段、重复键、别名、错误引用以及超过 1 MB 的配置。
导出从当前项目或小组配置生成，不导出账号身份、任务、评论、执行历史或连接凭据。
入口位于项目设置的“配置共享”和小组管理，不位于任务看板。

向已有项目导入默认追加小组，不覆盖已有小组或任务。名称冲突需要重命名。
若创建部分小组后失败，会提示检查已添加的小组，防止重复创建。

## 本地可用性

`shared/data/collaboration-templates.json` 是内置模板的源数据。
运行 `pnpm --filter @wegent/collaboration exec node ../../scripts/generate-collaboration-templates.mjs`
生成后端初始化 YAML。内置模板在首次启动且没有后端连接时即可使用。

下载配置与个人草稿缓存在设备上，缓存按后端、账号隔离。本地未登录身份与云端账号使用
不同作用域；切换账号不会自动转移草稿。已知账号断网时保存的草稿会在同账号连接恢复后
尝试私有同步；冲突保留草稿并显示状态，不自动覆盖源模板或公开发布。

## 验证

共享包包含配置校验、YAML 往返、缓存隔离、版本更新和部分失败测试。后端覆盖旧模板隔离及
资源库引用安装。`collaboration-templates` 桌面 checkpoint 覆盖真实 Rust/Python/MySQL
接口、权限、版本冲突、桌面创建、保存发布、项目追加导入和重载持久化；
`frontend/e2e/tests/collaboration/templates.spec.ts` 覆盖能力商店与 YAML 导入。
两者均接入既有 CI 运行器。证据截图保存在测试产物中，不提交仓库。
