---
sidebar_position: 1
---

# Wegent Knowledge Base Skill 文档读取统一化设计

## 背景

当前 `backend/init_data/skills/wegent-knowledge` 只提供知识库和文档的列举、创建、更新能力，缺少“读取文档正文内容”的 MCP 工具。

与此同时，后端已经存在三套相近但未统一的读取路径：

1. `backend/app/api/endpoints/knowledge.py` 中的 standalone `/detail` 接口
2. `backend/app/api/endpoints/knowledge.py` 中的 KB-scoped `/detail` 接口
3. `backend/app/services/rag/document_read_service.py` 与 `backend/app/api/endpoints/internal/rag.py` 中的 `offset/limit/has_more` 风格读取能力

这导致：

- MCP 无法直接读取知识库文档正文
- REST `/detail` 读取逻辑重复，且未复用 orchestrator
- 系统内同时存在“100k 预览截断语义”和“分页读取语义”，但缺少明确分层

## 目标

本次设计目标如下：

- 为 `wegent-knowledge` skill 增加单文档正文读取能力
- 统一通过 `backend/app/services/knowledge/orchestrator.py` 复用读取逻辑
- 底层统一采用 `offset/limit/has_more` 语义
- 保持现有 REST `/detail` 接口的对外行为不变
- 让现有 `/detail` 内部改为复用统一读取链路

## 非目标

本次不做以下内容：

- 不新增公开 REST 文档正文读取接口
- 不支持批量读取多个 `document_id`
- 不修改现有 `/detail` 的响应结构
- 不改变现有 skill 中除“读取正文”外的工具语义

## 方案对比

### 方案 1：只新增 MCP 读取工具

直接在 MCP 工具层新增 `read_document_content`，底层直接调用 `document_read_service`，REST `/detail` 保持原状。

优点：

- 改动最少

缺点：

- 无法满足统一经由 orchestrator 复用的要求
- `/detail` 逻辑仍然重复

### 方案 2：经由 orchestrator 统一内容读取与详情聚合

在 orchestrator 中引入内容读取核心方法和详情聚合方法。MCP 新工具与现有 REST `/detail` 都调用 orchestrator。底层统一复用 `document_read_service`。

优点：

- 读取核心只有一套实现
- MCP 与 REST 共享权限校验、参数校验和读取语义
- `/detail` 对外兼容，内部实现统一

缺点：

- 需要增加少量 orchestrator 和 schema 适配代码

### 方案 3：彻底改造 `/detail` 为分页读取协议

将现有 `/detail` 也直接改成 `offset/limit/has_more` 风格。

优点：

- 外部协议最统一

缺点：

- 会破坏现有调用方
- 不符合本次兼容性要求

## 选型

采用方案 2。

理由：

- 满足“统一通过 orchestrator 复用”的核心要求
- 不引入新的公开 REST 面
- 底层语义统一，兼容层清晰

## 总体设计

本次改动分为三层：

### 1. 底层读取层

继续复用 `backend/app/services/rag/document_read_service.py`。

该层负责：

- 根据 `document_id` 读取文档正文
- 按 `offset` 和 `limit` 返回正文片段
- 返回 `total_length`、`returned_length`、`has_more`

该层不负责：

- 用户权限校验
- REST `/detail` 兼容格式
- summary 聚合

### 2. Orchestrator 统一业务层

在 `backend/app/services/knowledge/orchestrator.py` 中新增两个方法：

#### `read_document_content(...)`

职责：

- 根据 `document_id` 找到文档
- 校验当前用户对所属知识库的访问权限
- 校验 `offset` 和 `limit`
- 调用 `document_read_service`
- 返回标准分页读取结果

该方法面向“正文读取”场景，供 MCP 新工具直接使用。

#### `get_document_detail(...)`

职责：

- 复用 `read_document_content(...)`
- 根据 `include_content` 决定是否读取正文
- 根据 `include_summary` 决定是否聚合 summary
- 统一将分页读取结果适配为现有 detail 响应

该方法面向“文档详情”场景，供现有 REST `/detail` 接口复用。

之所以保留两个方法，是为了分离两类语义：

- `read_document_content(...)` 是正文分页读取原子能力
- `get_document_detail(...)` 是兼容现有 `/detail` 的详情聚合能力

### 3. 对外适配层

#### MCP

在 `backend/app/mcp_server/tools/knowledge.py` 中新增：

- `read_document_content(document_id, offset=0, limit=100000)`

返回原生分页读取结果，不附带 summary。

#### REST

不新增公开 REST 正文读取接口。

保留现有两个 `/detail`：

- standalone document detail
- KB-scoped document detail

这两个 endpoint 内部统一改为调用 orchestrator 的 `get_document_detail(...)`，对外返回结构保持不变。

## 对外行为

### MCP 新工具

新增 `read_document_content`，参数如下：

- `document_id: int`
- `offset: int = 0`
- `limit: int = 100000`

返回字段如下：

- `document_id`
- `name`
- `content`
- `total_length`
- `offset`
- `returned_length`
- `has_more`
- `kb_id`

适用场景：

- 读取长文档前 100000 字符
- 基于 `has_more=true` 再次读取后续片段

### 现有 `/detail` 接口

现有 `/detail` 接口的对外协议不变，继续返回：

- `document_id`
- `content`
- `content_length`
- `truncated`
- `summary`

内部固定读取：

- `offset = 0`
- `limit = 100000`

字段映射规则统一为：

- `content_length = total_length`
- `truncated = has_more`

这意味着现有 `/detail` 仍然表现为“最多返回前 100000 字符的详情预览”，但其底层实现不再独立维护截断逻辑。

## 权限与错误处理

权限和错误处理统一收敛到 orchestrator。

### 权限规则

- 先通过 `document_id` 获取文档
- 再通过文档所属 `kb_id` 复用现有知识库访问校验逻辑
- MCP 与 REST 使用同一套权限判断

### 参数规则

- `offset >= 0`
- `limit > 0`
- `limit <= 100000`

### 错误语义

orchestrator 内部统一产生业务错误：

- `Document not found`
- `Knowledge base not found`
- `Access denied to this document`
- `Access denied to this knowledge base`
- 参数非法错误

对外映射如下：

- MCP：保持当前 knowledge MCP 工具风格，返回 `{ "error": "..." }`
- REST：继续映射为标准 HTTP 状态码
  - `404`：文档或知识库不存在
  - `403`：无权限
  - `400`：参数非法

### 空内容行为

如果文档存在但没有可读取的 `extracted_text`，则正文读取返回：

- `content = ""`
- `total_length = 0`
- `returned_length = 0`
- `has_more = false`

对应 `/detail` 的兼容结果为：

- `content = ""`
- `content_length = 0`
- `truncated = false`

## Summary 聚合策略

summary 不放入 `read_document_content(...)` 的返回中，而由 `get_document_detail(...)` 负责聚合。

原因：

- MCP 新工具的目标是读取正文，不需要承担详情聚合职责
- `/detail` 接口本质上是“详情视图”，应由专门的详情方法负责组装
- 这样可以避免把 summary 逻辑污染到原子读取能力中

为消除现有两个 `/detail` endpoint 的 summary 来源差异，`get_document_detail(...)`
统一使用 `summary_service.get_document_summary(document_id)` 作为 summary 的标准读取方式。
不再在 standalone `/detail` 中直接返回原始 `document.summary` 字段。

## 实现落点

本次改动涉及以下文件：

- `backend/app/services/knowledge/orchestrator.py`
  - 新增正文读取方法
  - 新增详情聚合方法

- `backend/app/mcp_server/tools/knowledge.py`
  - 新增 `read_document_content` MCP 工具

- `backend/init_data/skills/wegent-knowledge/SKILL.md`
  - 更新工具列表与使用说明

- `backend/app/api/endpoints/knowledge.py`
  - 将现有两个 `/detail` endpoint 改为调用 orchestrator

如需要新增独立 schema，可放在：

- `backend/app/schemas/knowledge.py`

## 测试设计

### Orchestrator 测试

覆盖以下场景：

- 正常读取文档正文，默认 `offset=0`、`limit=100000`
- 指定 `offset` 和 `limit` 后，返回正确的 `returned_length` 与 `has_more`
- 文档不存在
- 文档所属知识库不存在
- 用户无权限
- 文档没有正文内容
- 非法参数：负数 `offset`、非正 `limit`、超出上限的 `limit`
- `get_document_detail(...)` 正确映射 `content_length` 和 `truncated`

### MCP 测试

覆盖以下场景：

- `read_document_content` 成功返回分页读取结果
- orchestrator 抛出业务错误时，工具返回 `{ "error": "..." }`

### REST 测试

覆盖以下场景：

- 两个 `/detail` endpoint 都改为走 orchestrator
- 对外响应结构不变
- 长文档时 `truncated = true`
- 短文档时 `truncated = false`
- 两个 `/detail` endpoint 的 summary 都统一来自 `summary_service.get_document_summary(document_id)`

## 结果

本设计完成后，系统将形成清晰分层：

- `document_read_service` 负责正文分页读取
- `KnowledgeOrchestrator.read_document_content(...)` 负责统一正文读取业务
- `KnowledgeOrchestrator.get_document_detail(...)` 负责 detail 兼容聚合
- MCP 对外暴露真正的分页读取能力
- 现有 REST `/detail` 保持兼容，但底层统一复用 orchestrator
