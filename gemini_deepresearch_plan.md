# Gemini Interaction API (Deep Research) 集成方案

## 概述

本文档描述将 Gemini Interaction API (用于 Deep Research 功能) 集成到 chat_shell 的设计方案。

### 需求分析

**功能需求：**
1. 发起深度研究任务 (POST /v1beta/interactions) - 非流式
2. 轮询任务状态 (GET /v1beta/interactions/{id}) - 非流式
3. 获取结果 (GET /v1beta/interactions/{id}?stream=true) - 流式

**技术约束：**
- 任务执行时间长 (10+ 分钟)
- 发起和轮询使用非流式请求
- 最终结果获取使用流式
- 任务状态需要持久化到数据库
- 前端负责轮询状态

**SSE 事件类型 (获取结果时)：**
```
interaction.start
interaction.status_update
content.start (type: thought/text)
content.delta (type: thought_summary/text, with annotations)
content.stop
interaction.complete
done
```

### 内部后端 API 接口

```bash
# 发起任务
POST http://{base_url}/v1beta/interactions
Headers: x-goog-api-key: {api_key}
Body: {
    "background": true,
    "stream": false,
    "agent": "deep-research-pro-preview-12-2025",
    "input": "Research the history of Google TPUs."
}
Response: {"id":"5738096098665299968","object":"interaction","status":"in_progress"}

# 查询状态
GET http://{base_url}/v1beta/interactions/{id}
Headers: x-goog-api-key: {api_key}
Response: {"created":"...","id":"...","object":"interaction","status":"in_progress|completed","updated":"..."}

# 获取结果 (流式)
GET http://{base_url}/v1beta/interactions/{id}?stream=true
Headers: x-goog-api-key: {api_key}
Response: SSE stream with events
```

---

## 方案一：专用 API 端点 + 独立服务层

### 架构设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                        │
└─────────────────────────────────────────────────────────────────────────────┘
    │ POST /v1/deep-research                    │ GET /v1/deep-research/{id}
    │ (创建任务)                                │ (轮询状态/获取结果)
    ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        API Layer (FastAPI)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  chat_shell/api/v1/deep_research.py                                 │    │
│  │  - POST /deep-research          → 创建研究任务                       │    │
│  │  - GET /deep-research/{id}      → 获取状态（非流式）                  │    │
│  │  - GET /deep-research/{id}/stream → 获取结果（流式）                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      DeepResearchService                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  chat_shell/services/deep_research_service.py                        │    │
│  │  - create_interaction()    → 调用 Gemini API 创建任务                │    │
│  │  - get_status()            → 轮询 Gemini API 状态                    │    │
│  │  - stream_result()         → 流式获取结果并转换 SSE 事件             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GeminiInteractionClient                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  chat_shell/clients/gemini_interaction.py                            │    │
│  │  - HTTP 客户端封装                                                   │    │
│  │  - 非流式请求: create_interaction(), get_interaction()               │    │
│  │  - 流式请求: stream_interaction()                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Database (MySQL)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Table: deep_research_interactions                                   │    │
│  │  - id (local ID)                                                     │    │
│  │  - interaction_id (Gemini remote ID)                                 │    │
│  │  - status (in_progress, completed, failed)                           │    │
│  │  - input_query                                                       │    │
│  │  - agent_model                                                       │    │
│  │  - created_at, updated_at, completed_at                              │    │
│  │  - user_id, task_id, subtask_id (关联)                               │    │
│  │  - timeout_seconds                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 文件结构

```
chat_shell/
├── api/v1/
│   ├── deep_research.py          # NEW: 专用路由
│   └── schemas/
│       └── deep_research.py      # NEW: 请求/响应 Schema
├── clients/
│   └── gemini_interaction.py     # NEW: Gemini Interaction API 客户端
├── services/
│   └── deep_research_service.py  # NEW: 深度研究服务
├── db_models/
│   └── deep_research.py          # NEW: 数据库模型
└── core/
    └── config.py                 # 添加配置项
```

### 核心代码设计

#### 1. API Schema

```python
# chat_shell/api/v1/schemas/deep_research.py

class DeepResearchRequest(BaseModel):
    """创建深度研究任务请求"""
    model_config_data: ModelConfig = Field(..., alias="model_config")
    input: str = Field(..., description="研究查询内容")
    agent: str = Field("deep-research-pro-preview-12-2025", description="Agent 模型")
    timeout_seconds: int = Field(1800, ge=60, le=7200, description="超时时间(秒)")
    metadata: Optional[DeepResearchMetadata] = None


class DeepResearchResponse(BaseModel):
    """创建任务响应"""
    id: str = Field(..., description="本地任务 ID")
    interaction_id: str = Field(..., description="Gemini 远程 ID")
    status: str = Field(..., description="状态: in_progress, completed, failed")
    created_at: datetime


class DeepResearchStatusResponse(BaseModel):
    """状态查询响应"""
    id: str
    interaction_id: str
    status: str
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    estimated_completion: Optional[datetime] = None  # 预估完成时间
```

#### 2. SSE 事件转换

```python
# 将 Gemini Interaction API 事件转换为 chat_shell 标准事件

GEMINI_TO_CHAT_SHELL_EVENT_MAP = {
    "interaction.start": "response.start",
    "interaction.status_update": "response.status_update",  # NEW
    "content.start": "content.start",
    "content.delta": "content.delta",  # 需要处理 thought_summary 和 text
    "content.stop": "content.stop",
    "interaction.complete": "response.done",
}
```

### 优点

1. **职责分离清晰**：专用端点和服务，不侵入现有 `/v1/response` 逻辑
2. **易于测试**：独立模块可单独测试
3. **符合 RESTful 设计**：资源 URI 清晰 (`/deep-research/{id}`)
4. **扩展性好**：未来可轻松添加其他长时间任务类型

### 缺点

1. **代码量较大**：需要创建多个新文件
2. **重复代码**：SSE 处理逻辑与现有 `/v1/response` 有部分重复
3. **前端适配**：需要前端调用新的 API 端点

---

## 方案二：扩展现有 `/v1/response` 端点

### 架构设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                        │
└─────────────────────────────────────────────────────────────────────────────┘
    │ POST /v1/response (mode: deep-research)
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        API Layer (FastAPI)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  chat_shell/api/v1/response.py (扩展)                                │    │
│  │  - features.mode: "chat" | "deep-research"                          │    │
│  │  - 根据 mode 分发到不同处理器                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            │                                               │
            ▼                                               ▼
┌───────────────────────────┐               ┌───────────────────────────┐
│      ChatService          │               │   DeepResearchHandler     │
│   (现有聊天逻辑)           │               │   (新增深度研究处理器)     │
└───────────────────────────┘               └───────────────────────────┘
```

### Schema 扩展

```python
# chat_shell/api/v1/schemas.py (扩展)

class FeaturesConfig(BaseModel):
    # 现有字段...
    deep_thinking: bool = False
    clarification: bool = False
    streaming: bool = True
    
    # 新增字段
    mode: Literal["chat", "deep-research"] = "chat"
    deep_research_config: Optional[DeepResearchConfig] = None


class DeepResearchConfig(BaseModel):
    """深度研究配置"""
    agent: str = "deep-research-pro-preview-12-2025"
    timeout_seconds: int = 1800
    # 如果是创建任务，返回 task_id 给前端
    # 如果是查询/获取结果，需要提供 interaction_id
    interaction_id: Optional[str] = None
    action: Literal["create", "status", "stream"] = "create"
```

### 优点

1. **改动较小**：复用现有端点和部分逻辑
2. **前端适配简单**：只需在现有请求中添加参数
3. **统一入口**：所有 AI 相关请求通过同一端点

### 缺点

1. **违反单一职责**：`/v1/response` 变得臃肿，处理多种完全不同的任务类型
2. **代码耦合**：深度研究逻辑与聊天逻辑混在一起
3. **测试复杂**：难以单独测试深度研究功能
4. **REST 语义不清**：POST 请求用于查询状态不符合 RESTful 规范

---

## 方案三：新协议类型 + Model Factory 扩展

### 架构设计

将 Gemini Interaction API 作为一种新的 "协议" 集成到 Model Factory 中，类似于现有的 OpenAI、Anthropic、Google 协议。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LangChainModelFactory (扩展)                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  _PROVIDER_CONFIG = {                                                │    │
│  │      "openai": {...},                                                │    │
│  │      "anthropic": {...},                                             │    │
│  │      "google": {...},                                                │    │
│  │      "gemini-interaction": {  # NEW                                  │    │
│  │          "class": GeminiInteractionModel,                            │    │
│  │          "params": lambda cfg, kw: {...}                             │    │
│  │      }                                                               │    │
│  │  }                                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GeminiInteractionModel                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  实现 BaseChatModel 接口                                             │    │
│  │  - _generate() → 同步创建任务并轮询                                   │    │
│  │  - _agenerate() → 异步创建任务并轮询                                  │    │
│  │  - _stream() → 流式获取结果                                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 核心问题

**这种方案存在根本性问题：**

1. **模型抽象不匹配**：LangChain 的 `BaseChatModel` 设计为同步/短时任务，而 Deep Research 是长时间异步任务
2. **无法持久化状态**：Model Factory 不负责状态持久化
3. **轮询逻辑侵入**：会污染 Model Factory 的职责
4. **前端轮询需求无法满足**：LangChain 模型接口不支持 "创建任务-轮询状态-获取结果" 的三阶段模式

### 优点

1. **概念统一**：将 Gemini Interaction 视为一种特殊的 "模型"
2. **复用现有基础设施**：可能复用部分 LangChain 工具

### 缺点

1. **架构不匹配**：强行将长时间异步任务塞入同步模型抽象
2. **违反 SOLID**：LangChain Model 不应负责任务状态管理
3. **实现复杂**：需要 hack LangChain 接口来支持三阶段流程
4. **不推荐**：这是一个反模式

---

## 方案四：工具模式 (Tool-based Integration)

### 架构设计

将深度研究作为一个 LangChain Tool 实现，LLM 可以决定何时调用此工具。

```python
# chat_shell/tools/builtin/deep_research.py

class DeepResearchTool(BaseTool):
    """深度研究工具 - 由 LLM 决定何时调用"""
    
    name = "deep_research"
    description = """
    Use this tool to perform in-depth research on complex topics.
    This tool will take a long time (10+ minutes) to complete.
    ...
    """
    
    async def _arun(self, query: str) -> str:
        # 1. 创建研究任务
        # 2. 轮询直到完成
        # 3. 返回结果
        pass
```

### 优点

1. **自然集成**：符合现有工具架构
2. **LLM 决策**：由 AI 判断何时需要深度研究

### 缺点

1. **超时问题**：10+ 分钟的工具调用会导致连接超时
2. **无法前端轮询**：工具调用是原子性的，前端无法获取中间状态
3. **不符合需求**：用户明确要求前端轮询模式
4. **不推荐**：与需求不符

---

## 方案对比总结

| 维度 | 方案一 (专用 API) | 方案二 (扩展 response) | 方案三 (Model Factory) | 方案四 (Tool) |
|------|------------------|----------------------|---------------------|--------------|
| **职责分离** | ✅ 优秀 | ❌ 差 | ❌ 差 | ⚠️ 一般 |
| **符合 SOLID** | ✅ 是 | ❌ 否 | ❌ 否 | ⚠️ 部分 |
| **代码量** | ⚠️ 较多 | ✅ 较少 | ⚠️ 较多 | ✅ 较少 |
| **可测试性** | ✅ 优秀 | ⚠️ 一般 | ⚠️ 一般 | ✅ 优秀 |
| **前端轮询支持** | ✅ 原生支持 | ⚠️ 需 hack | ❌ 不支持 | ❌ 不支持 |
| **状态持久化** | ✅ 原生支持 | ✅ 可实现 | ❌ 不合适 | ❌ 不合适 |
| **可扩展性** | ✅ 优秀 | ⚠️ 一般 | ❌ 差 | ⚠️ 一般 |
| **架构匹配度** | ✅ 高 | ❌ 低 | ❌ 低 | ❌ 低 |
| **推荐程度** | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐ | ⭐ |

---

## 推荐方案：方案一 (专用 API 端点 + 独立服务层)

### 原因

1. **符合需求**：原生支持 "创建-轮询-获取" 三阶段模式
2. **职责清晰**：深度研究与普通聊天完全分离
3. **易于维护**：独立模块可单独测试和修改
4. **REST 规范**：资源 URI 设计清晰合理
5. **可扩展**：未来添加其他长时间任务类型时可复用架构

### 详细实现计划

#### Phase 1: 基础设施 (1-2 天)

1. **创建数据库模型和迁移**
   - `deep_research_interactions` 表
   - Alembic 迁移脚本

2. **创建 Gemini Interaction Client**
   - HTTP 客户端封装
   - 非流式请求 (create, get)
   - 流式请求 (stream)

#### Phase 2: 服务层 (1-2 天)

3. **创建 DeepResearchService**
   - `create_interaction()` - 创建任务
   - `get_status()` - 获取状态
   - `stream_result()` - 流式获取结果
   - 状态持久化到数据库

4. **SSE 事件转换器**
   - Gemini 事件 → Chat Shell 标准事件

#### Phase 3: API 层 (1 天)

5. **创建 API 端点**
   - `POST /v1/deep-research` - 创建任务
   - `GET /v1/deep-research/{id}` - 获取状态
   - `GET /v1/deep-research/{id}/stream` - 流式获取结果

6. **Schema 定义**
   - 请求/响应模型
   - 事件类型定义

#### Phase 4: 配置和测试 (1 天)

7. **配置项**
   - `DEEP_RESEARCH_ENABLED`
   - `DEEP_RESEARCH_DEFAULT_TIMEOUT`
   - `DEEP_RESEARCH_MAX_TIMEOUT`

8. **单元测试和集成测试**
   - Client mock 测试
   - Service 层测试
   - API 端点测试

### 文件清单

```
chat_shell/
├── api/v1/
│   ├── deep_research.py              # API 路由 (NEW)
│   └── schemas/
│       └── deep_research.py          # Schema 定义 (NEW)
├── clients/
│   ├── __init__.py                   # NEW
│   └── gemini_interaction.py         # HTTP 客户端 (NEW)
├── services/
│   ├── deep_research_service.py      # 服务层 (NEW)
│   └── streaming/
│       └── deep_research_emitter.py  # SSE 事件转换 (NEW)
├── db_models/
│   └── deep_research.py              # 数据库模型 (NEW)
└── core/
    └── config.py                     # 添加配置 (MODIFY)

alembic/
└── versions/
    └── xxx_add_deep_research_table.py  # 迁移脚本 (NEW)

tests/
└── test_deep_research.py             # 测试 (NEW)
```

### API 设计

#### 1. 创建任务

```http
POST /v1/deep-research
Content-Type: application/json

{
    "model_config": {
        "model_id": "deep-research-pro-preview-12-2025",
        "model": "gemini-interaction",
        "api_key": "sk-xxx",
        "base_url": "http://10.222.76.222:8080"
    },
    "input": "Research the history of Google TPUs.",
    "timeout_seconds": 1800,
    "metadata": {
        "task_id": 123,
        "subtask_id": 456,
        "user_id": 789
    }
}
```

响应:
```json
{
    "id": "dr-local-123",
    "interaction_id": "5738096098665299968",
    "status": "in_progress",
    "created_at": "2026-02-03T10:46:28Z"
}
```

#### 2. 查询状态

```http
GET /v1/deep-research/dr-local-123
```

响应:
```json
{
    "id": "dr-local-123",
    "interaction_id": "5738096098665299968",
    "status": "in_progress",
    "created_at": "2026-02-03T10:46:28Z",
    "updated_at": "2026-02-03T10:50:00Z",
    "completed_at": null,
    "elapsed_seconds": 212,
    "timeout_seconds": 1800
}
```

#### 3. 流式获取结果

```http
GET /v1/deep-research/dr-local-123/stream
Accept: text/event-stream
```

响应 (SSE):
```
event: response.start
data: {"id":"dr-local-123","status":"streaming"}

event: content.start
data: {"type":"thought","index":0}

event: content.delta
data: {"type":"thought_summary","text":"...","index":0}

event: content.stop
data: {"index":0}

event: content.start
data: {"type":"text","index":1}

event: content.delta
data: {"type":"text","text":"# The Evolution of Google TPUs...","annotations":[...]}

event: content.stop
data: {"index":1}

event: response.done
data: {"id":"dr-local-123","status":"completed","usage":{...}}
```

---

## 待澄清问题

在实施前，建议确认以下问题：

1. **Backend 集成方式**：chat_shell 的 Deep Research API 是否需要被 Backend 代理，还是前端直接调用 chat_shell？

回答：chat_shell 的 Deep Research API 是否需要被 Backend 代理

2. **权限控制**：是否需要在 chat_shell 层面做 API Key 验证，还是由 Backend 统一处理？

回答：由 Backend 统一处理

3. **结果缓存**：流式获取结果后，是否需要在本地缓存结果内容，以支持重复获取？

回答：不需要在本地缓存，每次流式获取内容从 Gemini 直接获取

4. **错误处理**：当 Gemini 返回错误或超时时，如何处理？是否需要支持重试？

回答：显示错误，暂时不支持重试

5. **并发限制**：是否需要限制每个用户/任务的并发 Deep Research 数量？

回答：不限制

6. **计费统计**：是否需要记录 usage 信息用于计费？

回答：不记录

---

## 参考资料

- [Gemini Interaction API 官方文档](https://ai.google.dev/gemini-api/docs/interactions?hl=zh-cn&ua=deep-research#rest_3)
- [chat_shell 协议文档](docs/zh/architecture/chat-shell-protocols.md)
- [AGENTS.md](AGENTS.md) - 项目规范
