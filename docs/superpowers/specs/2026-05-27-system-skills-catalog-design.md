---
sidebar_position: 1
---

# 系统技能目录设计

## 背景

Wework 插件页面现在有三个面向用户的分区：推荐、系统、个人。当前前端仍然静态渲染系统技能，但后端还没有提供系统技能目录 API。

现有后端能力相关，但不能直接复用：

- `/api/v1/kinds/skills` 管理用户拥有的 `Skill` 资源，数据存储在 `kinds` 表。
- `/api/skill-market/*` 是已有的技能市场集成，不应该被重定义为系统技能目录。
- MCP provider 已经采用多 provider 架构，包含 registry、配置型 provider、插件型 provider、service 层和统一响应 schema。

本设计为插件页面新增后端系统技能目录，同时保持个人技能和系统目录项的概念边界清晰。

## 目标

- 为插件页面的系统技能列表和搜索提供后端 API。
- 支持多个系统技能 provider。
- 返回与 provider 无关的统一目录项结构，便于前端渲染。
- 在目录响应中包含当前用户的安装状态和启用状态。
- 避免改变现有 `Skill` 的含义，避免复用或污染个人技能 API。
- 第一阶段不实现推荐技能。

## 非目标

- 不实现推荐分区。
- 不实现完整安装或更新流程。
- 不替换 `/api/v1/kinds/skills`。
- 不替换或重构 `/api/skill-market/*`。
- 不为安装关系新增 MySQL 表。

## 资源模型

### Skill

`Kind(kind="Skill")` 继续表示技能定义和技能包实体。它通过现有技能基础设施存储用户上传、Git 导入或系统提供的技能定义，以及相关二进制元数据。

### InstalledSkill

新增一个 CRD kind，仍然存储在现有 `kinds` 表中：

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "InstalledSkill",
  "metadata": {
    "name": "openai-image-gen",
    "namespace": "default"
  },
  "spec": {
    "source": {
      "type": "system",
      "providerKey": "openai",
      "skillKey": "image-gen",
      "catalogItemId": "@openai/image-gen"
    },
    "skillRef": {
      "kind": "Skill",
      "name": "image-gen",
      "namespace": "system",
      "user_id": 0
    },
    "displayName": "Image Gen",
    "description": "Generate or edit images",
    "version": "1.0.0",
    "installState": "installed",
    "enabled": false
  },
  "status": {
    "state": "Available"
  }
}
```

`InstalledSkill` 表示用户安装关系。它承载用户维度的状态，例如是否启用、安装状态、provider 身份，以及可选的可执行 `Skill` 引用。

`Skill` 和 `InstalledSkill` 刻意保持分离：

- `Skill`：技能定义和技能包。
- `InstalledSkill`：当前用户的安装和启用状态。

这样可以避免与现有个人上传技能发生语义冲突，同时为后续统一的已安装列表保留空间。

## 状态语义

安装状态和启用状态是两个独立维度：

| 场景 | `spec.installState` | `spec.enabled` |
| --- | --- | --- |
| 未安装 | 没有 `InstalledSkill`，目录响应返回 `not_installed` | `false` |
| 已安装且启用 | `installed` | `true` |
| 已安装但未启用 | `installed` | `false` |
| 有可用更新 | `update_available` | 保持用户当前设置 |
| 来源不可用或权限失效 | `unavailable` | `false` |
| 安装失败残留 | `failed` | `false` |

目录 API 应该在 provider 目录数据与当前用户 `InstalledSkill` 记录合并后，为每个条目返回 `installState` 和 `enabled`。

## API 设计

### 列出 Provider

```http
GET /api/system-skills/providers
```

响应：

```json
{
  "providers": [
    {
      "key": "openai",
      "name": "OpenAI",
      "description": "OpenAI system skills",
      "requiresToken": false,
      "hasToken": false,
      "priority": 10
    }
  ]
}
```

### 列出或搜索系统技能

```http
GET /api/system-skills
```

查询参数：

- `providerKey`：可选 provider 过滤条件。不传时聚合所有可用 provider。
- `keyword`：可选关键词搜索。
- `tags`：可选逗号分隔标签。
- `page`：默认 `1`。
- `pageSize`：默认 `20`。
- `category`：默认 `system`。第一阶段只支持 `system`。

响应：

```json
{
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "id": "@openai/image-gen",
      "providerKey": "openai",
      "providerName": "OpenAI",
      "name": "image-gen",
      "displayName": "Image Gen",
      "description": "Generate or edit images",
      "iconUrl": null,
      "tags": ["image", "frontend"],
      "version": "1.0.0",
      "author": "OpenAI",
      "category": "system",
      "capabilities": ["generate_image"],
      "detailUrl": "https://example.com/skills/image-gen",
      "installState": "installed",
      "enabled": true,
      "requiresPermission": false,
      "permissionUrl": null,
      "updatedAt": "2026-05-27T00:00:00Z"
    }
  ],
  "providerErrors": [
    {
      "providerKey": "example",
      "code": "timeout",
      "message": "Provider request timed out"
    }
  ]
}
```

Provider 错误码：

- `token_required`
- `unauthorized`
- `timeout`
- `connect_error`
- `provider_error`
- `mapping_error`

聚合请求中，只要至少一个 provider 成功，就应该返回部分成功结果。失败的 provider 放入 `providerErrors`。单 provider 请求也可以返回稳定结构：`items` 为空，同时带对应的 `providerErrors`。

## Provider 架构

新增一个与 MCP provider 平行的 provider 子系统：

```text
backend/app/services/system_skill_providers/
  core/
    registry.py
    http_client.py
    mapper.py
  providers/
    base.py
    builtin.py
  service.py
backend/app/schemas/system_skills.py
backend/app/api/endpoints/system_skills.py
```

Provider 支持两种模式：

- 配置型 provider：声明 API 路径和字段映射，由默认 HTTP client 和 mapper 归一化 provider 数据。
- 插件型 provider：实现自定义拉取和映射逻辑，用于鉴权、分页、签名或响应结构不标准的平台。

Registry 应支持多个 provider、按优先级排序、自动发现和自定义注册，整体参考 MCP provider 模型。

Provider token 只作为认证材料存放在用户偏好中，类似 MCP provider key。安装状态不能存放在 `users.preferences` 中。

## 数据流

```text
Frontend
  -> GET /api/system-skills?keyword=image
  -> endpoint 解析当前用户
  -> SystemSkillProviderService 选择 provider
  -> provider 拉取目录或搜索结果
  -> mapper 归一化目录项
  -> service 加载当前用户的 InstalledSkill 记录
  -> service 合并 installState/enabled 到目录项
  -> endpoint 返回统一响应
```

安装状态按来源身份匹配：

```text
user_id = 当前用户
kind = InstalledSkill
is_active = true
json.spec.source.type = system
json.spec.source.providerKey = providerKey
json.spec.source.skillKey = skillKey
```

## 个人技能兼容

个人上传和 Git 导入的技能继续使用 `Kind(kind="Skill")`。

第一阶段系统目录实现不需要迁移已有个人技能。未来已安装列表接口可以合并：

- 系统或 provider 安装产生的 `InstalledSkill` 记录。
- 用户已有的个人上传和 Git 导入 `Skill` 记录。

这样既保持当前个人技能行为不变，又允许后续把已安装管理页做成统一视图。

## 测试

Service 测试：

- Registry 能注册多个 provider，并按优先级排序。
- Provider 列表包含 token 需求元数据。
- 能从多个 provider 聚合系统技能。
- 关键词搜索能正确过滤或透传搜索行为。
- 一个 provider 失败不会导致多 provider 响应整体失败。
- 需要 token 的 provider 在用户未配置凭据时返回 `token_required`。
- 当前用户的 `InstalledSkill` 记录能合并为 `installState` 和 `enabled`。
- “已安装但未启用”表示为 `installState=installed` 且 `enabled=false`。

API 测试：

- `GET /api/system-skills/providers` 返回 provider 元数据。
- `GET /api/system-skills` 返回统一目录项。
- `GET /api/system-skills?keyword=image` 返回过滤后的结果。
- Provider 错误以稳定的 `providerErrors` 结构返回。
- 现有 `/api/v1/kinds/skills` 行为保持不变。

## 第一阶段实现范围

第一阶段实现应包含：

- Provider 信息、目录项、列表响应和 provider 错误 schema。
- Provider registry 和 service。
- 一个内置 provider，提供确定性的系统技能数据，用于第一版前端集成。
- `InstalledSkill` schema，以及合并安装状态所需的最小 service helper。
- Provider 和系统技能 API endpoint。
- 初始 provider、搜索和安装状态合并测试。

安装动作可以在列表/搜索契约稳定后再实现。
