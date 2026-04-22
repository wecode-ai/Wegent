---
sidebar_position: 20
---

# Knowledge Runtime 架构设计

本文档描述 Knowledge Runtime 服务的架构设计，包括组件职责、通信协议和部署架构。

---

## 背景与问题

### 当前架构问题

根据代码分析，当前架构存在以下问题：

1. **Backend 依赖重型库**：通过 `local_data_plane` 直接依赖 `knowledge_engine`，引入 llama-index、pymilvus、docx2txt、PyPDF2 等重型依赖，导致 Backend 镜像体积较大

2. **无法水平扩展**：所有 RAG 操作在 Backend 进程内执行，无法独立扩展计算密集型的索引和检索操作

3. **资源竞争**：文档解析、embedding 计算等 CPU 密集型操作与 API 请求处理共享资源

### 设计目标

- **服务解耦**：创建独立的 `knowledge_runtime` 服务，Backend 通过 HTTP 调用
- **独立扩展**：RAG 计算层可独立水平扩展
- **向后兼容**：保留 `LocalRagGateway` 作为 fallback，支持灰度切换
- **协议透明**：使用已有的 `knowledge_runtime_protocol.py` 通信模型

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Backend (控制面)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  HTTP API    │  │  MCP Tools   │  │  Internal API│                   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                   │
│         │                  │                  │                         │
│         └──────────────────┼──────────────────┘                         │
│                            ▼                                            │
│                   ┌─────────────────┐                                   │
│                   │  Orchestrator   │  ← 权限校验、请求路由、结果组装    │
│                   └────────┬────────┘                                   │
│                            ▼                                            │
│                   ┌─────────────────┐                                   │
│                   │  Gateway Factory│  ← local/remote 模式选择          │
│                   └────────┬────────┘                                   │
│                            │                                            │
│         ┌──────────────────┼──────────────────┐                         │
│         ▼                  ▼                  ▼                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                  │
│  │LocalRagGateway│   │RemoteRagGateway│  │  Fallback   │                  │
│  │  (fallback)  │    │   (主路径)   │    │   Handler   │                  │
│  └─────────────┘    └──────┬──────┘    └─────────────┘                  │
│                            │ HTTP                                       │
└────────────────────────────┼────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        knowledge_runtime (数据面)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  HTTP API    │  │  Content     │  │  Auth        │                   │
│  │  (FastAPI)   │  │  Fetcher     │  │  Middleware  │                   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘                   │
│         │                  │                                            │
│         └──────────────────┼────────────────────────────────────────────┤
│                            ▼                                            │
│                   ┌─────────────────┐                                   │
│                   │ knowledge_engine│  ← 执行内核（文档解析、分块、      │
│                   │                 │    embedding、向量索引读写）       │
│                   └────────┬────────┘                                   │
│                            ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    存储后端 (Milvus / ES / Qdrant)                │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 组件职责

### Backend (控制面)

| 职责 | 说明 |
|------|------|
| 权限校验 | 验证用户对知识库的访问权限 |
| 请求路由 | 根据 `RAG_RUNTIME_MODE` 选择 local/remote |
| 结果组装 | 组装检索结果，处理 direct injection 路由 |
| 配置解析 | 解析 Retriever/Embedding 运行时配置 |
| 受限调解 | 处理受保护知识库的安全摘要生成 |

**不承担的职责**：
- 不执行实际的文档解析、分块、embedding
- 不直接访问向量数据库

### knowledge_runtime (数据面)

| 职责 | 说明 |
|------|------|
| 协议转换 | 接收 `RemoteXxxRequest`，调用 `knowledge_engine` |
| 内容拉取 | 通过 `ContentRef` 获取文件内容 |
| 执行委托 | 调用 `knowledge_engine` 执行 RAG 操作 |
| 结果序列化 | 返回 `RemoteXxxResponse` 格式结果 |

**不承担的职责**：
- 不处理权限校验
- 不访问 Backend 数据库
- 不理解业务语义（知识库、文档等）

### knowledge_engine (执行内核)

| 职责 | 说明 |
|------|------|
| 文档解析 | 支持 PDF、DOCX、Markdown 等格式 |
| 文档分块 | 支持 flat、semantic、hierarchical 分块策略 |
| Embedding | 支持 OpenAI、Cohere、Jina 等协议 |
| 向量索引 | 支持 Milvus、Elasticsearch、Qdrant |

**特点**：
- Backend-agnostic，无业务依赖
- 纯 Python 库，无 HTTP 包装

---

## 通信协议

### 端点映射

| 操作 | HTTP 端点 | 请求模型 | 响应模型 |
|------|----------|----------|----------|
| 文档索引 | `POST /internal/rag/index` | `RemoteIndexRequest` | `dict` |
| 知识检索 | `POST /internal/rag/query` | `RemoteQueryRequest` | `RemoteQueryResponse` |
| 删除文档索引 | `POST /internal/rag/delete-document-index` | `RemoteDeleteDocumentIndexRequest` | `dict` |
| 清除知识库索引 | `POST /internal/rag/purge-knowledge-index` | `RemotePurgeKnowledgeIndexRequest` | `dict` |
| 删除物理索引 | `POST /internal/rag/drop-knowledge-index` | `RemoteDropKnowledgeIndexRequest` | `dict` |
| 列出 chunks | `POST /internal/rag/all-chunks` | `RemoteListChunksRequest` | `RemoteListChunksResponse` |
| 测试连接 | `POST /internal/rag/test-connection` | `RemoteTestConnectionRequest` | `dict` |

### 认证机制

使用 Bearer Token 认证：

```http
Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
```

Token 必须与 Backend 的 `INTERNAL_SERVICE_TOKEN` 配置一致。

### 内容传输机制

索引操作使用 `ContentRef` 传输文件内容，避免在请求体中传输大文件：

```python
# 方式1: 通过 Backend 内部 API 流式获取
ContentRef(kind="backend_attachment_stream", url="...", auth_token="...")

# 方式2: 通过预签名 URL 直接从对象存储获取
ContentRef(kind="presigned_url", url="...")
```

### 错误处理

远程服务返回标准化的错误格式：

```python
class RemoteRagError:
    code: str          # 错误代码，如 "index_failed"
    message: str       # 错误消息
    retryable: bool    # 是否可重试
    details: dict      # 详细信息
```

Backend 根据 `retryable` 和 HTTP 状态码决定是否 fallback 到 `LocalRagGateway`：

```python
def should_fallback_to_local(error: RemoteRagGatewayError) -> bool:
    return error.retryable or (
        error.status_code is not None and error.status_code >= 500
    )
```

---

## 运行模式

### 配置方式

`RAG_RUNTIME_MODE` 支持两种配置格式：

```bash
# 全局模式
RAG_RUNTIME_MODE=local   # 或 remote

# 按操作配置（灰度切换）
RAG_RUNTIME_MODE={"default":"local","query":"remote"}
```

### 灰度切换策略

| 阶段 | 配置 | 说明 |
|------|------|------|
| 阶段 1 | `{"default":"local","query":"remote"}` | 仅查询使用 remote |
| 阶段 2 | `{"default":"local","query":"remote","index":"remote"}` | 查询+索引使用 remote |
| 阶段 3 | `{"default":"remote"}` | 全部使用 remote，保留 local fallback |

### Fallback 机制

```
RemoteRagGateway 调用
    │
    ├── 成功 → 返回结果
    │
    └── 失败
         │
         ├── retryable=True 或 5xx 错误
         │       │
         │       └── fallback 到 LocalRagGateway
         │
         └── retryable=False 且 4xx 错误
                 │
                 └── 抛出异常，不 fallback
```

---

## 部署架构

### Docker Compose

```yaml
services:
  knowledge_runtime:
    image: ghcr.io/wecode-ai/wegent-knowledge-runtime:latest
    ports:
      - "8200:8200"
    environment:
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN}
      - BACKEND_INTERNAL_URL=http://backend:8000
    depends_on:
      - backend
    networks:
      - wegent-network
```

### 服务依赖关系

```
                    ┌─────────────┐
                    │   Milvus    │
                    └──────┬──────┘
                           │
┌─────────────┐     ┌──────┴──────┐     ┌─────────────┐
│   Backend   │────▶│ knowledge_  │────▶│  Elasticsearch│
│  (:8000)    │     │   runtime   │     └─────────────┘
└──────┬──────┘     │   (:8200)   │
       │            └─────────────┘
       │
       ▼
┌─────────────┐
│   MySQL     │
└─────────────┘
```

### 资源配置建议

| 服务 | CPU | 内存 | 说明 |
|------|-----|------|------|
| knowledge_runtime | 1-2 核 | 2-4 GB | 文档解析和 embedding 计算 |
| Backend | 1 核 | 1-2 GB | API 请求处理 |

---

## 关键文件

| 文件 | 说明 |
|------|------|
| `shared/models/knowledge_runtime_protocol.py` | 通信协议模型定义 |
| `backend/app/services/rag/remote_gateway.py` | RemoteRagGateway 实现 |
| `backend/app/services/rag/local_gateway.py` | LocalRagGateway 实现 |
| `backend/app/services/rag/gateway_factory.py` | Gateway 工厂 |
| `knowledge_engine/knowledge_engine/services/document_service.py` | 文档索引核心 |
| `knowledge_engine/knowledge_engine/query/executor.py` | 查询执行核心 |