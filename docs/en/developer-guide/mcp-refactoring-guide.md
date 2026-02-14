---
sidebar_position: 10
---

# MCP Tool Refactoring Guide

English | [简体中文](../../zh/developer-guide/mcp-refactoring-guide.md)

This document describes the refactored architecture for Knowledge MCP tools, helping developers quickly understand the current implementation state and future development direction.

---

## 📋 Refactoring Overview

### Background

The original MCP tools directly called `KnowledgeService`, which had the following issues:

1. Business logic duplicated between REST API and MCP tools
2. Auto-configuration logic (retriever, embedding model) was inconsistent
3. MCP tools required manual parameter schema definition
4. Different async mechanisms (BackgroundTasks vs Celery) caused code duplication

### Goals

1. **Unified Business Layer**: Introduce `KnowledgeOrchestrator` as a unified business orchestration layer
2. **Decorator-based Auto-registration**: Use `@mcp_tool` decorator to auto-generate MCP schema
3. **Auto-selection**: Implement automatic selection of retriever, embedding, and summary model at the Orchestrator layer
4. **Unified Async Mechanism**: Use Celery for all async indexing tasks

---

## 🏗️ Architecture Diagram

### Post-refactoring Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Entry Layer                             │
├─────────────────────────────────────────────────────────────┤
│  REST API (FastAPI)          │  MCP Tools (Standalone)       │
│  app/api/endpoints/          │  app/mcp_server/tools/        │
│  knowledge.py                │  knowledge.py                 │
│                              │  @mcp_tool decorator          │
└──────────────┬───────────────┴───────────────┬───────────────┘
               │                               │
               │       Unified Calls           │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Orchestrator Layer                           │
├─────────────────────────────────────────────────────────────┤
│  KnowledgeOrchestrator                                       │
│  app/services/knowledge/orchestrator.py                      │
│                                                              │
│  Responsibilities:                                           │
│  - Auto-select retriever/embedding/summary model             │
│  - Orchestrate complete business workflows                   │
│  - Schedule async tasks via Celery                           │
└──────────────────────────────┬──────────────────────────────┘
               │               │
               ▼               ▼
┌────────────────────────┐   ┌────────────────────────────────┐
│    Service Layer       │   │      Async Task Layer          │
├────────────────────────┤   ├────────────────────────────────┤
│  KnowledgeService      │   │  Celery Tasks                  │
│  knowledge_service.py  │   │  tasks/knowledge_tasks.py      │
│                        │   │                                │
│  - Database CRUD       │   │  - index_document_task         │
│  - Basic validation    │   │  - generate_document_summary   │
└────────────────────────┘   └───────────────┬────────────────┘
                                             │
                                             ▼
                             ┌────────────────────────────────┐
                             │    Shared Indexing Module      │
                             ├────────────────────────────────┤
                             │  services/knowledge/indexing.py │
                             │                                │
                             │  - run_document_indexing()     │
                             │  - KnowledgeBaseIndexInfo      │
                             │  - RAGIndexingParams           │
                             └────────────────────────────────┘
```

---

## 📁 Core Files

| File | Purpose | Status |
|------|---------|--------|
| `backend/app/mcp_server/tools/decorator.py` | `@mcp_tool` decorator implementation | ✅ Complete |
| `backend/app/mcp_server/tools/knowledge.py` | Knowledge MCP tool definitions | ✅ Complete |
| `backend/app/services/knowledge/orchestrator.py` | Business orchestration layer | ✅ Complete |
| `backend/app/services/knowledge/indexing.py` | Shared RAG indexing logic | ✅ Complete |
| `backend/app/tasks/knowledge_tasks.py` | Celery tasks for async operations | ✅ Complete |
| `backend/app/api/endpoints/knowledge.py` | REST API endpoints | ✅ Uses Celery |

---

## 🔧 `@mcp_tool` Decorator

### Usage

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
    token_info: TaskTokenInfo,  # Auto-injected, excluded from MCP schema
    name: str,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    ...
```

### Features

- `token_info` parameter automatically excluded from MCP schema
- Support custom parameter descriptions
- Auto-infer parameter types and default values
- Build MCP tools dict via `build_mcp_tools_dict()`

---

## 📊 API Migration Status

### All APIs Migrated ✅

| API | REST API | MCP Tool | Notes |
|-----|----------|----------|-------|
| List Knowledge Bases | ✅ | ✅ | `list_knowledge_bases` |
| List Documents | ✅ | ✅ | `list_documents` |
| Create Knowledge Base | ✅ | ✅ | `create_knowledge_base` |
| Get Knowledge Base | ✅ | ✅ | `get_knowledge_base` |
| Update Knowledge Base | ✅ | ✅ | `update_knowledge_base` |
| Create Document | ✅ | ✅ | `create_document` - Both use Celery |
| Update Document Content | ✅ | ✅ | `update_document_content` - Both use Celery |
| Reindex Document | ✅ | ❌ | `reindex_document` - Uses Orchestrator |
| Create Web Document | ✅ | ❌ | `create_web_document` - Uses Orchestrator |
| Refresh Web Document | ✅ | ❌ | `refresh_web_document` - Uses Orchestrator |
| Delete Document | ✅ | ❌ | MCP tool not implemented |

### Unified Async Mechanism

Both REST API and MCP tools now use Celery for async task scheduling:

```python
# Both REST API and MCP tools use the same approach
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

## 🎯 Summary Model Auto-selection Logic

When `summary_enabled=True` but `summary_model_ref` is not specified:

### Selection Priority

1. **Task Model Resolution**: Task → Team → Bot → Model
2. **First Available LLM**: Via `model_aggregation_service.list_available_models()`
3. **Fallback**: If no model available, automatically set `summary_enabled` to `False`

### Model Type Field

`summary_model_ref` must include a `type` field to distinguish model source:

```python
summary_model_ref = {
    "name": "model-name",
    "namespace": "default",
    "type": "public"  # or "user" or "group"
}
```

| Type | Description |
|------|-------------|
| `public` | System public model (user_id=0) |
| `user` | User private model (namespace=default) |
| `group` | Group shared model (namespace=group_name) |

---

## 🧪 Test Coverage

| Test File | Coverage |
|-----------|----------|
| `backend/tests/mcp_server/test_tools_decorator.py` | `@mcp_tool` decorator tests |
| `backend/tests/services/knowledge/test_orchestrator.py` | Orchestrator business logic tests |

---

## 📝 Future Development Suggestions

### Potential Enhancements

1. **Implement `delete_document` MCP tool**: Complete functionality documented in SKILL.md
2. **Add `reindex_document` MCP tool**: Expose reindex capability to AI agents (Orchestrator method ready)
3. **Add `create_web_document` MCP tool**: Expose web scraping capability to AI agents (Orchestrator method ready)
4. **Batch operations**: Consider adding batch create/update/delete for efficiency

### Design Principles

- All business logic centralized in `KnowledgeOrchestrator`
- REST API and MCP Tools only handle parameter parsing and response formatting
- Async task scheduling unified through Celery
- Shared indexing logic in `services/knowledge/indexing.py` to avoid circular imports
- Web scraping logic also centralized in Orchestrator (`create_web_document`, `refresh_web_document`)

---

## 🔗 Related Documentation

- [CRD Architecture](./crd-architecture.md)
- [Knowledge Base User Guide](../user-guide/knowledge/README.md)
- [Skill Development Guide](./skill-development.md)
