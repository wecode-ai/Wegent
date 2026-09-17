# `backend-rs` 内网逻辑归属审计（2026-09-17）

## 范围与判断依据

本次静态审查覆盖 `backend-rs/src`、`backend-rs/tests` 中从 `wegent-be-rs` 迁入的实现，并对照 `Wegent-github/backend` 与 `Wegent-intra/backend/wecode`。判断实现归属以 Python 源码路径为准：`backend/wecode/**` 的实现和专用样例只能进入 `backend-rs-intra`；公开 crate 可以声明通用接口并提供开源 Python 对应的默认实现。

已检查显式名称（`wecode`、`tauth`、`nevis`、`erp` 等）、Redis 键、分片表和迁移旧记录路径。名称扫描只用于定位，以下结论均经源码路径核对。未运行流量回归。

## 已确认的越界实现

| 类别 | `backend-rs` 位置 | Python 归属证据 | 应完成的拆分 |
| --- | --- | --- | --- |
| 内网任务分片与迁移旧记录 | `attachments/context_store.rs`、`chat_repository.rs`、`projects.rs`、`responses/responses_repository.rs`、`runtime_check/tasks.rs`、`skills/skill_download.rs`、`task_detail_api/repository.rs`、`remote_workspace_status/task_detail.rs`、`tasks_lite_personal/lite_repository.rs`、`teams/recent_teams/repository.rs` 等 | `backend/wecode/task_sharding/task_store.py`、`subtask_store.py`；由 `backend/wecode/api/__init__.py` 安装。开源版对应 `backend/app/stores/tasks/sqlalchemy_task_store.py`。 | **已增加边界开关**：公开 `TaskPolicy` 默认使用基表且不探测内网迁移旧记录；内网启动注入 `TaskRouting`、新 ID 判定并打开 `resolve_migrated_legacy`。项目列表、响应 workspace 查找、附件访问的基表/fallback 分支也已接入该开关。仍需逐个 API 做行为验证后再接管。 |
| 内网 Redis reader 缓存 | 旧实现涉及 `task_skills/kinds.rs`、`remote_workspace_tree/kinds.rs`、`responses/auth.rs`、`knowledge_documents_content/auth.rs`、`task_detail_api/views.rs`、`remote_workspace_status/users.rs` 等 | `backend/wecode/cache/{users,kinds,groups,group_members,shared_teams}.py` 定义版本化键、空值缓存、TTL、回填及事件失效；开源 `backend/app/services/readers/**` 默认直接读数据库。 | **已处理公开调用链**：公开用户/Kind/共享 Team reader 改为开源直读 SQL，删除公开 `group_cache` 模块；Redis 参数只保留兼容形状。内网缓存 wrapper 尚未重新接入，缓存带来的性能差异需单独评估。 |
| 知识库文档下载策略 | 原 `knowledge_base_detail.rs` 的组织 namespace 默认禁止下载分支 | `backend/wecode/service/knowledge/document_protection_policy.py`；开源 `backend/app/services/knowledge/document_download_policy.py` 仅在显式 `allowDocumentDownload=false` 时禁止下载。 | **已处理**：公开默认策略在 `knowledge_download_policy.rs`，内网策略在 `backend-rs-intra/src/wecode/document_download_policy.rs`，通过 `AppState` 注入。 |
| Workspace 订阅读取 | 原 `subscriptions_list/workspaces.rs` 的分片查询 | `backend/wecode/task_sharding/**`；开源版从基表读取。 | **已处理**：公开版 `WorkspaceRepository` 使用基表；内网 `subscription_workspaces.rs` 注入分片实现。 |
| 任务 ID 编码 | 原 `task_routing.rs::is_new_task_id` | `backend/wecode/task_sharding/task_id.py`。 | **已处理**：公开默认不按内网 ID 判定；内网启动注入判定与路由。 |
| 员工目录和部门关系 | `erp_provider.rs` 的通用目录契约及权限调用方 | 内网 `backend/wecode` ERP client、员工 profile 和具体实体 resolver；开源 Python 只提供可注册的外部实体扩展。 | 公开调用链统一通过 `ErpProvider::entity_type` 和 `EntityResolvers` 注入；Noop 默认不查询外部实体，具体实体类型和 ERP 注册只在内网。 |
| Marketplace 外部实体授权 | 原 `plugins_marketplace/service.rs` 中的 `org_department` 授权查询 | 内网 `marketplace_access_target_service.py` 才增加部门授权；开源版本只处理 user/namespace grant。 | **已处理**：公开代码改为遍历已注册的 external entity resolver；公开 registry 无外部 resolver，内网注册后保留部门授权。 |

模板化 `{{tasks}}` / `{{subtasks}}` SQL 和通用路由 key 可以留在公开 crate，但其中的分片探测、旧记录合并、缓存键与物理分片默认行为必须拆出。当前 `task_export_docx/repository.rs`、`task_skills/repository.rs`、`attachments_task_all/repository.rs`、`tasks_lite_personal/lite_repository.rs` 和 `teams/recent_teams/repository.rs` 只通过通用路由 key 访问任务表；公开启动的 `NoSharding` 将其解析为基表，内网启动才安装物理分片路由。

## 内外网共用且通过 provider 解耦的逻辑

| 能力 | 公共契约 | 开源默认实现 | 内网注入实现 |
| --- | --- | --- | --- |
| 任务表/ID 路由 | `task_routing::TaskPolicy`、`ByTaskId`、`ByUserId` | `NoSharding`、基表、关闭迁移探测 | `TaskRouting`、新 ID 判定、开启迁移探测 |
| Workspace 订阅读取 | `subscriptions_list::workspaces::WorkspaceRepository` | `BaseWorkspaceRepository` | `ShardedWorkspaceRepository` |
| 用户响应扩展 | `user_profile::UserViewExtension` | 空字段 | `WecodeUserProfile` |
| 附件媒体限制 | `media_policy::MediaPolicy` | 不额外限制 | `WecodeMediaPolicy` |
| 知识库原文下载 | `knowledge_download_policy::DocumentDownloadPolicy` | 只遵循公开配置项 | `WecodeDocumentDownloadPolicy`，检查组织 namespace |
| 员工/部门目录 | `erp_provider::ErpProvider`、`permissions::EntityResolvers` | `NoopErpProvider`，未知外部实体不放行 | ERP provider + `org_department` resolver |
| 视频结果 URL | `video_result_urls::VideoResultUrlRefresh` | 原样返回 | Weibo/TAuth 播放地址刷新 |

这些 provider 只在应用启动时替换，公共 handler 不直接依赖 tauth、Nevis、ERP、AIGC 等内部客户端。`ErpProvider` 的公开路径仍保留通用权限计算，Noop 实现返回空目录结果。

`knowledge_bases_all_grouped/membership.rs` 已改为遍历注册的 external entity type；`teams/group_membership.rs`、`models_unified/aggregation.rs` 和 `skills/skills_unified.rs` 也只在 provider 声明实体类型时执行外部实体查询。公开默认 provider 不声明实体类型，因此不会访问内网目录；内网通过 `EntityResolvers` 注册具体 resolver。

## 测试数据和字符串

| 项目 | 结论 |
| --- | --- |
| `knowledge_base_detail.rs` 的真实内网 KB/模型样例 | 已替换为通用测试数据。 |
| `backend-rs/tests/export_docx_*` 的内网录制内容和预期 DOCX | 已移动到 `backend-rs-intra/tests/`，公开 crate 不再携带这组内容。 |
| `plugins_marketplace/components.rs`、`tasks_lite_personal/lite_repository.rs` 的内部命名样例 | 已替换为 `mail-connector`、`team-check` 等合成样例；其余测试仅保留结构和行为断言。 |
| `tests/fixtures/typed_responses` | README 已移除内网产品名说明；快照仍按原样固定，不改写测试基线。 |
| `agent.wecode.io/v1` | **可保留**。它在 `Wegent-github/backend/app/schemas/**` 和公开初始化资源中是现行 CRD 协议版本，字符串中含 `wecode` 不代表内网专用逻辑。 |
| `/api/internal/chat/**` 等路径 | 不能仅凭 `internal` 字样分类；这些路径存在于开源 `backend/app`，按实际来源判定。 |

## 路由状态与验证

`backend-rs/config/routes.toml` 已覆盖公开 crate 的 66 个已注册 API 路径（含 exact 与 template 规则）；`backend-rs-intra/config/routes.toml` 继承公开规则并追加 quota、AIGC 播放、云设备配置、灰度状态和 external-knowledge 五个内网路径。路由测试会校验公开配置覆盖全部公开注册项，内网测试会校验私有注册项和模板匹配。

公开和内网 crate 均已通过 `cargo check`；公开单元测试 673 个、内网单元测试 81 个通过，内网 DOCX 集成测试 2 个通过。公开文档测试也已通过。严格 Clippy 未作为本批验收门槛；迁入参考代码仍有既存 lint 警告。按要求未运行流量回归，只做编译、路由和单元测试验证。

公开 OIDC 回调已补齐开源成功路径：授权码交换、JWKS/ID Token 校验、可选 userinfo、用户 upsert 和会话 JWT 重定向；provider 失败仍保持源端 502/登录错误重定向语义。
