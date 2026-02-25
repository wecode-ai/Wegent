---
sidebar_position: 10
---

# MCP 工具重构指南

[English](../../en/developer-guide/mcp-refactoring-guide.md) | 简体中文

本文档介绍 Knowledge MCP 工具的重构架构，帮助开发者快速理解当前实现状态和后续开发方向。

---

## 📋 重构概述

### 背景

原有的 MCP 工具直接调用 `KnowledgeService`，存在以下问题：

1. REST API 和 MCP 工具的业务逻辑重复
2. 参数自动配置（如 retriever、embedding model）逻辑不统一
3. MCP 工具需要手动定义参数 schema
4. 不同的异步机制（BackgroundTasks vs Celery）导致代码重复

### 重构目标

1. **统一业务层**：引入 `KnowledgeOrchestrator` 作为统一的业务编排层
2. **装饰器自动注册**：使用 `@mcp_tool` 装饰器自动生成 MCP schema
3. **配置自动选择**：在 Orchestrator 层实现 retriever、embedding、summary model 的自动选择
4. **统一异步机制**：所有异步索引任务统一使用 Celery

---

## 🏗️ 架构图

### 重构后的架构

```
┌─────────────────────────────────────────────────────────────┐
│                      入口层 (Entry Layer)                     │
├─────────────────────────────────────────────────────────────┤
│  REST API (FastAPI)          │  MCP Tools (Standalone)       │
│  app/api/endpoints/          │  app/mcp_server/tools/        │
│  knowledge.py                │  knowledge.py                 │
│                              │  @mcp_tool 装饰器               │
└──────────────┬───────────────┴───────────────┬───────────────┘
               │                               │
               │         统一调用               │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 编排层 (Orchestrator Layer)                   │
├─────────────────────────────────────────────────────────────┤
│  KnowledgeOrchestrator                                       │
│  app/services/knowledge/orchestrator.py                      │
│                                                              │
│  职责:                                                        │
│  - 自动选择 retriever/embedding/summary model                 │
│  - 编排完整业务流程                                            │
│  - 通过 Celery 调度异步任务                                    │
└──────────────────────────────┬──────────────────────────────┘
               │               │
               ▼               ▼
┌────────────────────────┐   ┌────────────────────────────────┐
│      服务层            │   │       异步任务层                │
├────────────────────────┤   ├────────────────────────────────┤
│  KnowledgeService      │   │  Celery Tasks                  │
│  knowledge_service.py  │   │  tasks/knowledge_tasks.py      │
│                        │   │                                │
│  - 数据库 CRUD         │   │  - index_document_task         │
│  - 基础验证            │   │  - generate_document_summary   │
└────────────────────────┘   └───────────────┬────────────────┘
                                             │
                                             ▼
                             ┌────────────────────────────────┐
                             │      共享索引模块               │
                             ├────────────────────────────────┤
                             │  services/knowledge/indexing.py │
                             │                                │
                             │  - run_document_indexing()     │
                             │  - KnowledgeBaseIndexInfo      │
                             │  - RAGIndexingParams           │
                             └────────────────────────────────┘
```

---

## 📁 核心文件

| 文件 | 用途 | 状态 |
|------|------|------|
| `backend/app/mcp_server/tools/decorator.py` | `@mcp_tool` 装饰器实现 | ✅ 完成 |
| `backend/app/mcp_server/tools/knowledge.py` | Knowledge MCP 工具定义 | ✅ 完成 |
| `backend/app/services/knowledge/orchestrator.py` | 业务编排层 | ✅ 完成 |
| `backend/app/services/knowledge/indexing.py` | 共享 RAG 索引逻辑 | ✅ 完成 |
| `backend/app/tasks/knowledge_tasks.py` | Celery 异步任务 | ✅ 完成 |
| `backend/app/api/endpoints/knowledge.py` | REST API 端点 | ✅ 使用 Celery |

---

## 🔧 `@mcp_tool` 装饰器

### 使用方式

```python
from app.mcp_server.tools.decorator import mcp_tool

@mcp_tool(
    name="create_knowledge_base",
    description="Create a new knowledge base",
    server="knowledge",
    param_descriptions={
        "name": "Knowledge base name",
        "description": "Optional description",
    },
)
def create_knowledge_base(
    token_info: TaskTokenInfo,  # 自动注入，不出现在 MCP schema
    name: str,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    ...
```

### 特性

- `token_info` 参数自动排除，不出现在 MCP schema
- 支持自定义参数描述
- 自动推断参数类型和默认值
- 通过 `build_mcp_tools_dict()` 构建 MCP 工具字典

---

## 📊 API 迁移状态

### 所有 API 已迁移 ✅

| 接口 | REST API | MCP Tool | 说明 |
|------|----------|----------|------|
| 列出知识库 | ✅ | ✅ | `list_knowledge_bases` |
| 列出文档 | ✅ | ✅ | `list_documents` |
| 创建知识库 | ✅ | ✅ | `create_knowledge_base` |
| 获取知识库 | ✅ | ✅ | `get_knowledge_base` |
| 更新知识库 | ✅ | ✅ | `update_knowledge_base` |
| 创建文档 | ✅ | ✅ | `create_document` - 均使用 Celery |
| 更新文档内容 | ✅ | ✅ | `update_document_content` - 均使用 Celery |
| 重新索引文档 | ✅ | ❌ | `reindex_document` - 使用 Orchestrator |
| 创建网页文档 | ✅ | ❌ | `create_web_document` - 使用 Orchestrator |
| 刷新网页文档 | ✅ | ❌ | `refresh_web_document` - 使用 Orchestrator |
| 删除文档 | ✅ | ❌ | MCP 工具未实现 |

### 统一异步机制

REST API 和 MCP 工具现在都使用 Celery 进行异步任务调度：

```python
# REST API 和 MCP 工具使用相同的方式
from app.tasks.knowledge_tasks import index_document_task

index_document_task.delay(
    knowledge_base_id=str(kb_id),
    attachment_id=attachment_id,
    retriever_name=retriever_name,
    retriever_namespace=retriever_namespace,
    embedding_model_name=embedding_model_name,
    embedding_model_namespace=embedding_model_namespace,
    user_id=user_id,
    user_name=user_name,
    document_id=document_id,
    splitter_config_dict=splitter_config,
    trigger_summary=True,
)
```

---

## 🎯 Summary Model 自动选择逻辑

当 `summary_enabled=True` 但未指定 `summary_model_ref` 时：

### 选择优先级

1. **Task 标签解析**：Task.metadata.labels.modelId（运行时模型覆盖）
2. **Task 链式解析**：Task → Team → Bot → Model（静态配置回退）
3. **首个可用 LLM**：通过 `model_aggregation_service.list_available_models()` 获取
4. **降级处理**：若无可用模型，自动将 `summary_enabled` 设为 `False`

### 模型类型字段

`summary_model_ref` 必须包含 `type` 字段来区分模型来源：

```python
summary_model_ref = {
    "name": "model-name",
    "namespace": "default",
    "type": "public"  # 或 "user" 或 "group"
}
```

| 类型 | 说明 |
|------|------|
| `public` | 系统公共模型 (user_id=0) |
| `user` | 用户私有模型 (namespace=default) |
| `group` | 组织共享模型 (namespace=group_name) |

---

## 🧪 测试覆盖

| 测试文件 | 覆盖内容 |
|----------|----------|
| `backend/tests/mcp_server/test_tools_decorator.py` | `@mcp_tool` 装饰器测试 |
| `backend/tests/services/knowledge/test_orchestrator.py` | Orchestrator 业务逻辑测试 |

---

## 📝 后续开发建议

### 可能的增强

1. **实现 `delete_document` MCP 工具**：补充 SKILL.md 中记录的功能
2. **添加 `reindex_document` MCP 工具**：向 AI 代理暴露重新索引能力（Orchestrator 方法已就绪）
3. **添加 `create_web_document` MCP 工具**：向 AI 代理暴露网页抓取能力（Orchestrator 方法已就绪）
4. **批量操作**：考虑添加批量创建/更新/删除以提高效率

### 设计原则

- 所有业务逻辑集中在 `KnowledgeOrchestrator`
- REST API 和 MCP Tools 只负责参数解析和响应格式化
- 异步任务调度统一通过 Celery
- 共享索引逻辑放在 `services/knowledge/indexing.py` 以避免循环导入
- 网页抓取逻辑也集中在 Orchestrator 中（`create_web_document`、`refresh_web_document`）

---

## 🔗 相关文档

- [CRD 架构](./crd-architecture.md)
- [知识库用户指南](../user-guide/knowledge/README.md)
- [Skill 开发指南](./skill-development.md)
