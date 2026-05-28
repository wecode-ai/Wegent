---
sidebar_position: 4
---

# 资源库设计

## 背景

Wegent 当前已经有多种可复用资源：

- 智能体：代码层是 `Team`，由 `Bot`、`Ghost`、`Shell`、`Model` 等资源组成。
- Skill：可上传 ZIP 包，并通过 `Ghost.spec.skills[]` 供智能体按需加载。
- MCP：可通过用户级 MCP 配置和机器人级 `mcp_servers` 供执行链路使用。

这些资源分散在设置、公开资源、Skill 搜索、MCP 配置等不同模块中。用户希望有一个统一入口，用于发现、安装、发布和管理智能体、Skill、MCP。

本设计将该能力命名为“资源库”。前端文案、后端 API、数据表、服务命名都围绕 Resource Library / 资源库。

## 目标

- 左侧侧边栏新增“资源库”入口。
- 新增 `/resource-library` 页面。
- 页面一级任务为“发现”和“我的”。
- 资源类型作为筛选维度：`全部`、`智能体`、`Skill`、`MCP`。
- 支持用户开放发布资源到资源库，发布后立即可被发现。
- 支持安装资源到当前用户空间。
- 支持管理已安装资源和我发布的资源。
- 后端新增完整资源库领域模型，而不是前端直接拼接多个旧接口。
- 安装后仍落回现有运行体系：智能体落到 Team/Bot/Ghost，Skill 落到 Skill/SkillBinary，MCP 落到用户 MCP 资源配置。

## 非目标

- 本轮不做付费、租赁、订单、分成等交易能力。
- 本轮不做发布审核流程。
- 本轮不做评分、评论、举报。
- 本轮不做组织级权限分发策略，只支持当前用户可发布、可安装的个人级资源。
- 本轮不重构现有 Team、Skill、MCP 的运行时使用方式。
- 本轮不要求自动把已安装 MCP 绑定到某个智能体。

## 当前状态

### 前端

- 主工作区页面使用 `frontend/src/features/tasks/components/sidebar/TaskSidebar.tsx` 渲染左侧导航。
- 页面路由集中在 `frontend/src/app/(tasks)/`。
- 现有设置页通过 `TeamListWithScope`、`SkillListWithScope`、`McpProviderIntegrations` 管理资源。
- `SkillSearchModal` 已有从 Skill 外部提供方搜索、下载、安装到本地 Skill 的流程。
- 用户 MCP 配置在 `frontend/src/features/settings/components/McpProviderIntegrations.tsx` 中维护。

### 后端

- 智能体通过 `/teams` 和 `team_kinds_service` 管理。
- Skill 通过 `/v1/kinds/skills` 和 `skill_kinds_service` 管理，并有 `SkillBinary` 保存 ZIP 内容。
- MCP 用户配置通过 `UserMCPService` 存储在用户 preferences 的 `mcps` 子树中。
- 当前没有统一的资源库条目、版本、安装记录模型。

## 信息架构

左侧导航新增：

- `资源库`

资源库页面结构：

- 一级标签：
  - `发现`
  - `我的`
- 资源类型筛选：
  - `全部`
  - `智能体`
  - `Skill`
  - `MCP`

`发现`页用于浏览、搜索、查看详情和安装资源。

`我的`页包含：

- `已安装`：打开、升级、移除已安装资源。
- `我发布的`：编辑信息、发布新版本、归档资源。

## 数据模型

新增三个核心表。

### `resource_library_listings`

资源库条目，用于列表、搜索、详情页展示。

关键字段：

- `id`
- `resource_type`: `agent | skill | mcp`
- `name`
- `display_name`
- `description`
- `icon`
- `tags`
- `publisher_user_id`
- `status`: `published | archived`
- `current_version_id`
- `install_count`
- `created_at`
- `updated_at`

约束：

- `resource_type + name + publisher_user_id` 唯一。
- 查询默认只返回 `status = published` 的资源。
- 发布者和管理员可以看到自己归档的资源。

### `resource_library_versions`

资源版本，保存安装所需的 manifest 和源资源引用。

关键字段：

- `id`
- `listing_id`
- `version`
- `manifest`
- `source_kind_id`
- `source_binary_id`
- `is_current`
- `created_at`
- `updated_at`

`manifest` 按资源类型区分内容：

- 智能体：Team CRD 快照、Bot/Ghost 引用、技能引用、MCP 引用、依赖元信息。
- Skill：Skill CRD 元信息、ZIP/binary 引用、版本、标签。
- MCP：服务名称、server config 模板、provider metadata、需要用户补充的凭据字段。

约束：

- `listing_id + version` 唯一。
- 每个 listing 最多一个 `is_current = true` 的版本。

### `resource_library_installs`

安装记录，记录用户安装了哪个资源版本以及安装后对应的本地资源。

关键字段：

- `id`
- `listing_id`
- `version_id`
- `user_id`
- `resource_type`
- `installed_kind_id`
- `installed_reference`
- `install_status`: `installed | removed | failed`
- `error_message`
- `installed_at`
- `updated_at`

`installed_reference` 用于保存按类型不同的结果：

- 智能体：`{ "team_id": 1, "namespace": "default", "name": "copy-name" }`
- Skill：`{ "skill_id": 2, "namespace": "default", "name": "skill-name" }`
- MCP：`{ "provider_id": "custom", "service_id": "service-name" }`

## 后端服务

新增模块：

- `app/models/resource_library.py`
- `app/schemas/resource_library.py`
- `app/services/resource_library/service.py`
- `app/services/resource_library/installers.py`
- `app/api/endpoints/adapter/resource_library.py`

服务边界：

- `ResourceLibraryService` 负责编排条目、版本、安装记录。
- `ResourceLibraryInstaller` 负责按资源类型分发安装逻辑。
- `AgentResourceInstaller` 负责复制 Team/Bot/Ghost。
- `SkillResourceInstaller` 负责创建 Skill/SkillBinary。
- `McpResourceInstaller` 负责写入用户 MCP 资源配置。

## API 设计

统一使用 `/resource-library`。

### 发现

`GET /resource-library/listings`

查询参数：

- `resource_type?: agent | skill | mcp`
- `keyword?: string`
- `tags?: string`
- `page?: number`
- `limit?: number`

返回：

- `total`
- `items[]`

`GET /resource-library/listings/{listing_id}`

返回资源详情、当前版本、发布者摘要、当前用户是否已安装。

### 我的

`GET /resource-library/users/me/installs`

查询参数：

- `resource_type?: agent | skill | mcp`
- `status?: installed | removed | failed`
- `page?: number`
- `limit?: number`

`GET /resource-library/users/me/published`

查询参数：

- `resource_type?: agent | skill | mcp`
- `status?: published | archived`
- `page?: number`
- `limit?: number`

### 发布

`POST /resource-library/listings`

创建资源条目并发布第一个版本。请求包含：

- `resource_type`
- `source_id`
- `name`
- `display_name`
- `description`
- `tags`
- `version`

`POST /resource-library/listings/{listing_id}/versions`

发布新版本，并把该版本设为当前版本。

`POST /resource-library/listings/{listing_id}/archive`

归档资源。只有发布者或管理员可操作。

### 安装

`POST /resource-library/listings/{listing_id}/install`

请求参数：

- `version_id?`
- `target_namespace?`
- `install_options?`

返回：

- 安装记录
- 安装后的资源引用

`POST /resource-library/installs/{install_id}/upgrade`

升级到当前版本或指定版本。

`DELETE /resource-library/installs/{install_id}`

移除安装记录。移除是否删除本地资源按资源类型处理：

- 智能体：默认只把安装记录标记为 removed，不删除用户已复制的 Team。
- Skill：默认只标记 removed，不删除 Skill，避免破坏已有智能体引用。
- MCP：可以禁用或移除用户 MCP 资源配置。

## 发布流程

1. 用户在“我的”页点击“发布资源”。
2. 选择资源类型：智能体、Skill、MCP。
3. 选择源资源或填写 MCP 配置模板。
4. 填写展示信息和版本号。
5. 后端生成对应 `manifest`。
6. 创建 `resource_library_listings` 和 `resource_library_versions`。
7. 条目状态为 `published`，立即出现在“发现”页。

### 智能体发布

发布时保存 Team CRD 快照和依赖引用。manifest 需要包含：

- Team metadata/spec
- Team members
- Bot/Ghost 引用
- Skill 引用元信息
- MCP 引用元信息
- bind_mode、requires_workspace、icon

安装时复制成用户自己的 Team/Bot/Ghost，避免安装者修改源发布者资源。

### Skill 发布

发布时保存 Skill CRD 元信息和 ZIP/binary 引用。

安装时复制 SkillBinary，创建当前用户自己的 Skill Kind。

### MCP 发布

发布时保存 MCP server config 模板，不保存发布者的私密凭据。

安装时写入当前用户 MCP 资源配置；如果模板需要凭据，安装后显示“需要配置”状态，由用户补充 URL/token 后启用。

## 安装流程

### 智能体

1. 读取当前版本 manifest。
2. 为当前用户生成可用 Team/Bot/Ghost 名称。
3. 复制 Team/Bot/Ghost。
4. 对 Skill 和 MCP 引用做可安装性校验。
5. 创建安装记录。
6. 返回安装后的 Team ID。

### Skill

1. 读取当前版本 manifest 和 binary。
2. 检查当前用户命名空间是否存在同名 Skill。
3. 生成可用名称或要求用户确认覆盖策略。
4. 创建 Skill Kind 和 SkillBinary。
5. 创建安装记录。
6. 返回 Skill ID。

### MCP

1. 读取 MCP manifest。
2. 写入用户 preferences 的 MCP 资源配置。
3. 对需要用户补充的字段标记为未配置。
4. 创建安装记录。
5. 返回 provider/service 引用。

## 权限与安全

- 只有登录用户可以发布和安装资源。
- 用户只能归档自己发布的资源；管理员可以归档任何资源。
- 发布资源不能包含明文密钥、token、私有 URL 凭据。
- MCP manifest 只能保存配置模板和字段说明，不能保存发布者凭据。
- 安装智能体时复制资源，不共享可写引用，避免安装者影响发布者资源。
- 资源详情接口不返回敏感字段。

## 错误处理

- 源资源不存在：返回 404。
- 用户无权发布源资源：返回 403。
- 同名资源冲突：返回 409，并给出建议名称。
- 当前版本不存在或已归档：返回 404。
- 安装部分失败：安装记录写入 `failed`，并保存 `error_message`。
- MCP 需要用户补充配置：安装成功，但返回 `requires_configuration = true`。

## 前端实现

新增目录：

- `frontend/src/app/(tasks)/resource-library/page.tsx`
- `frontend/src/features/resource-library/`
- `frontend/src/apis/resourceLibrary.ts`
- `frontend/src/i18n/locales/zh-CN/resource-library.json`
- `frontend/src/i18n/locales/en/resource-library.json`

主要组件：

- `ResourceLibraryPage`
- `ResourceLibraryNav`
- `ResourceTypeFilter`
- `ResourceListingGrid`
- `ResourceListingCard`
- `ResourceDetailDrawer`
- `MyInstalledResources`
- `MyPublishedResources`
- `PublishResourceDialog`

左侧导航：

- 在 `TaskSidebar` 中增加 `资源库` 按钮。
- 新增路径配置 `paths.resourceLibrary.getHref() -> /resource-library`。

移动端：

- 保持现有侧边栏抽屉模式。
- 资源类型筛选使用横向可滚动 segmented control。
- 操作按钮满足 44px 触控尺寸。

## 国际化

新增 `resource-library` namespace，中文优先，英文同步。

关键文案：

- `资源库`
- `发现`
- `我的`
- `全部`
- `智能体`
- `Skill`
- `MCP`
- `已安装`
- `我发布的`
- `发布资源`
- `安装`
- `已安装`
- `升级`
- `归档`
- `需要配置`

## 测试策略

### 后端

新增测试覆盖：

- 数据模型约束。
- 创建资源条目和首版本。
- 发布新版本并切换 current version。
- 列表搜索和类型筛选。
- 当前用户已安装状态。
- 智能体安装复制 Team/Bot/Ghost。
- Skill 安装复制 Skill/SkillBinary。
- MCP 安装写入用户 MCP 资源配置。
- 归档权限。
- 安装失败记录。

命令：

```bash
cd backend && uv run pytest tests/services/resource_library tests/api/endpoints/test_resource_library.py
```

### 前端

新增测试覆盖：

- 左侧出现资源库入口。
- `/resource-library` 默认进入“发现”。
- 类型筛选调用正确 API 参数。
- 安装按钮成功后显示已安装状态。
- “我的”页展示已安装和我发布的资源。
- 发布对话框按资源类型展示不同字段。

命令：

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library
cd frontend && npm run lint
```

## 迁移与兼容

- 新增 Alembic migration 创建 `resource_library_*` 表。
- 不迁移现有公开资源；初始版本只展示通过资源库发布的新资源。
- 现有 Team、Skill、MCP 管理功能保持不变。
- 已安装资源复制为当前用户资源，不对源资源产生写入。

## 风险与取舍

- 完整资源库模型比复用旧接口改动更大，但后续扩展“我的”、版本、安装记录会更清晰。
- 开放发布降低初期流程复杂度，但需要后续补充举报、下架、可见范围等治理能力。
- 智能体依赖复制涉及 Team/Bot/Ghost/Skill/MCP 多种资源，必须先做窄路径实现和充分测试。
- MCP 安装只进入用户资源配置，不直接绑定智能体，能降低误修改智能体配置的风险。

## 验收标准

- 左侧导航可进入资源库。
- 用户可以在资源库发现页浏览智能体、Skill、MCP。
- 用户可以发布自己的智能体、Skill、MCP 到资源库。
- 用户可以安装资源，并在“我的 / 已安装”中看到安装记录。
- 安装智能体后，设置页智能体列表能看到复制出的 Team。
- 安装 Skill 后，设置页 Skill 列表能看到复制出的 Skill。
- 安装 MCP 后，用户 MCP 资源配置中能看到该服务，并可继续补充配置。
- 资源库实现中不使用其他产品概念作为产品、API、表或服务命名。
