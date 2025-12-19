# LangGraph Chat Service

基于 LangChain/LangGraph 框架的企业级 Chat Service 模块，提供 OpenAI 兼容的 Chat Completions API。

## 功能特性

### 🎯 核心能力

- **多 LLM 提供商支持**
  - OpenAI (GPT-4o, GPT-4-turbo, etc.)
  - Anthropic (Claude 3.5 Sonnet, etc.)
  - Google Gemini (Gemini 2.0 Flash, etc.)
  - 自动检测提供商，统一接口调用

- **工具调用系统**
  - MCP (Model Context Protocol) 集成
    - SSE (Server-Sent Events) 传输
    - stdio (标准输入输出) 传输
    - streamable-http (HTTP 流式) 传输
  - Skills 大文件处理
    - 分块文件读取 (`read_file`)
    - 文件列表 (`list_files`)
  - 内置工具
    - Web 搜索 (预留接口)

- **深度思考模式**
  - 多步推理工具循环
  - 可配置最大迭代次数
  - 自动工具调用与结果反馈

- **流式输出**
  - SSE (Server-Sent Events) 流式响应
  - OpenAI 兼容的 chunk 格式

- **多租户隔离**
  - 用户级别资源隔离
  - 命名空间共享机制

## 架构设计

### 模块结构

```
backend/app/services/langgraph_chat/
├── __init__.py
├── service.py                  # 主服务入口
├── config.py                   # 配置管理
│
├── providers/                  # LLM 提供商适配
│   ├── base.py                # BaseLLMProvider 抽象类
│   ├── openai_provider.py     # OpenAI 适配器
│   ├── anthropic_provider.py  # Anthropic 适配器
│   ├── gemini_provider.py     # Google Gemini 适配器
│   └── factory.py             # Provider 工厂
│
├── tools/                      # 工具系统
│   ├── base.py                # BaseTool、ToolRegistry
│   ├── mcp/                   # MCP 工具集成
│   │   ├── client.py          # MCP 客户端
│   │   ├── adapter.py         # MCP 工具适配器
│   │   └── session.py         # MCP 会话管理
│   ├── skills/                # Skills 系统
│   │   ├── file_reader.py     # 文件读取工具
│   │   └── registry.py        # Skills 注册表
│   └── builtin/               # 内置工具
│       └── web_search.py      # Web 搜索工具
│
├── agents/                     # Agent 实现 (预留)
├── state/                      # 状态管理 (预留)
├── streaming/                  # 流式输出 (预留)
├── storage/                    # 数据持久化 (预留)
├── multimodal/                 # 多模态处理 (预留)
├── telemetry/                  # 可观测性 (预留)
└── isolation/                  # 多租户隔离 (预留)
```

### 核心组件

#### 1. LangGraphChatService

主服务类，提供统一的 Chat Completion 接口。

```python
from app.services.langgraph_chat import LangGraphChatService

# 初始化服务
service = LangGraphChatService(
    workspace_root="/workspace",
    enable_mcp=True,
    enable_skills=True,
    enable_web_search=False
)

await service.initialize()

# 执行对话
response = await service.chat_completion(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=False,
    deep_thinking=True,
    max_tool_iterations=10
)
```

#### 2. LLM Provider 适配器

统一多个 LLM 提供商的接口差异。

```python
from app.services.langgraph_chat.providers import ProviderFactory

# 自动检测提供商
provider = ProviderFactory.create_provider(model="gpt-4o")
provider = ProviderFactory.create_provider(model="claude-3-5-sonnet")
provider = ProviderFactory.create_provider(model="gemini-2.0-flash")

# 统一调用接口
response = await provider.chat_completion(
    messages=[...],
    tools=[...],
    stream=True
)
```

#### 3. 工具系统

可扩展的工具注册与执行机制。

```python
from app.services.langgraph_chat.tools import BaseTool, ToolRegistry

# 注册工具
registry = ToolRegistry()
registry.register(FileReaderSkill(workspace_root="/workspace"))

# 执行工具
result = await registry.execute_tool("read_file", file_path="README.md", offset=0, limit=100)
```

#### 4. MCP 集成

支持多种传输协议的 MCP 工具集成。

```python
from app.services.langgraph_chat.tools.mcp import MCPClient

# SSE 连接
session = await client.connect_sse(
    server_name="image-gen",
    url="http://localhost:8080/sse"
)

# stdio 连接
session = await client.connect_stdio(
    server_name="local-tool",
    command="python",
    args=["mcp_server.py"]
)

# 调用工具
result = await session.call_tool("generate_image", {"prompt": "a cat"})
```

## 配置说明

### 环境变量

```bash
# 服务版本切换
LANGGRAPH_CHAT_SERVICE_VERSION=v2  # v1=现有服务, v2=LangGraph服务

# LLM API 密钥
LANGGRAPH_OPENAI_API_KEY=sk-xxx
LANGGRAPH_OPENAI_BASE_URL=https://api.openai.com/v1
LANGGRAPH_ANTHROPIC_API_KEY=sk-ant-xxx
LANGGRAPH_GOOGLE_API_KEY=xxx

# Agent 配置
LANGGRAPH_DEFAULT_MAX_TOOL_ITERATIONS=10
LANGGRAPH_TOOL_EXECUTION_TIMEOUT=30

# MCP 配置
LANGGRAPH_MCP_ENABLED=true
LANGGRAPH_MCP_SERVERS='{"image-gen": {"type": "sse", "url": "http://localhost:8080/sse"}}'

# Skills 配置
LANGGRAPH_SKILLS_ENABLED=true
LANGGRAPH_FILE_READER_MAX_LINES=500

# Redis 配置
LANGGRAPH_REDIS_CHECKPOINT_TTL=3600

# OpenTelemetry 配置
LANGGRAPH_OTEL_ENABLED=false
LANGGRAPH_OTEL_EXPORTER_ENDPOINT=http://localhost:4317
```

### MCP 服务器配置格式

```json
{
  "mcpServers": {
    "image-gen": {
      "type": "sse",
      "url": "http://localhost:8080/sse",
      "headers": {
        "Authorization": "Bearer xxx"
      }
    },
    "local-tool": {
      "type": "stdio",
      "command": "python",
      "args": ["mcp_server.py"],
      "env": {
        "API_KEY": "xxx"
      }
    },
    "web-api": {
      "type": "streamable-http",
      "url": "http://api.example.com",
      "headers": {
        "X-API-Key": "xxx"
      }
    }
  }
}
```

## API 使用

### POST /api/v2/chat/completions

OpenAI 兼容的 Chat Completions API。

**请求格式：**

```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true,
  "tools": [],
  "tool_choice": "auto",
  "temperature": 1.0,
  "max_tokens": 4096,
  "wegent_options": {
    "task_id": 123,
    "deep_thinking": true,
    "max_tool_iterations": 10,
    "mcp_servers": ["image-gen"],
    "skills": ["read_file"],
    "user_id": 1,
    "namespace": "default"
  }
}
```

**响应格式（非流式）：**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?",
        "tool_calls": null
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

**响应格式（流式 SSE）：**

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}

data: [DONE]
```

### GET /api/v2/chat/tools

列出可用工具。

**响应示例：**

```json
[
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read file content with pagination support...",
      "parameters": {
        "type": "object",
        "properties": {
          "file_path": {"type": "string", "description": "File path or attachment ID"},
          "offset": {"type": "integer", "default": 0},
          "limit": {"type": "integer", "default": 200}
        },
        "required": ["file_path"]
      }
    }
  }
]
```

## 集成到现有系统

### 1. 在 backend/app/main.py 添加启动钩子

```python
from app.api.endpoints.v2.chat import initialize_chat_service, shutdown_chat_service
from app.core.config import settings

@app.on_event("startup")
async def startup():
    if settings.CHAT_SERVICE_VERSION == "v2":
        await initialize_chat_service(workspace_root=settings.WORKSPACE_ROOT)

@app.on_event("shutdown")
async def shutdown():
    if settings.CHAT_SERVICE_VERSION == "v2":
        await shutdown_chat_service()
```

### 2. 注册路由

```python
from app.api.endpoints.v2 import chat as chat_v2
from app.core.config import settings

if settings.CHAT_SERVICE_VERSION == "v2":
    app.include_router(
        chat_v2.router,
        prefix="/api/v2/chat",
        tags=["chat-v2"]
    )
```

## 开发指南

### 添加新的 LLM 提供商

1. 在 `providers/` 创建新文件（如 `cohere_provider.py`）
2. 继承 `BaseLLMProvider` 并实现抽象方法
3. 在 `factory.py` 的 `_provider_map` 添加映射

```python
class CohereProvider(BaseLLMProvider):
    async def chat_completion(self, ...):
        # 实现 Cohere API 调用
        pass

    def convert_to_provider_format(self, messages):
        # 实现消息格式转换
        pass
```

### 添加新工具

1. 在 `tools/builtin/` 或 `tools/skills/` 创建工具文件
2. 继承 `BaseTool` 并实现 `execute` 方法
3. 定义 `input_schema` (Pydantic 模型)
4. 注册到 `ToolRegistry`

```python
class MyToolInput(ToolInput):
    param1: str = Field(description="...")
    param2: int = Field(default=0)

class MyTool(BaseTool):
    name = "my_tool"
    description = "..."
    input_schema = MyToolInput

    async def execute(self, param1: str, param2: int = 0) -> ToolResult:
        # 实现工具逻辑
        return ToolResult(success=True, output="result")
```

## 依赖说明

```toml
# pyproject.toml 新增依赖
"anthropic>=0.30.0"
"openai>=1.0.0"
"google-generativeai>=0.7.0"
"langchain>=0.3.0"
"langgraph>=0.2.0"
"langchain-openai>=0.2.0"
"langchain-anthropic>=0.2.0"
"langchain-google-genai>=2.0.0"
```

## 测试

```bash
# 单元测试
cd backend
pytest tests/services/langgraph_chat/ -v

# 集成测试
pytest tests/api/endpoints/v2/ -v

# 测试覆盖率
pytest --cov=app/services/langgraph_chat --cov-report=html
```

## 实现状态

### ✅ 已完成核心功能
- [x] **Provider 适配器** - 使用 LangChain 官方集成 (ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI)
- [x] **工具系统基础** - BaseTool、ToolRegistry 注册与执行
- [x] **主服务入口** - LangGraphChatService 统一接口
- [x] **MCP 集成** - SSE、stdio、streamable-http 三种传输协议
- [x] **Skills 文件读取** - 分块读取、文件列表
- [x] **LangGraph 状态图构建器** - 基于 StateGraph 实现 agent → tools → agent 循环
- [x] **真实的智能体工作流** - AgentState 状态管理 + 自动工具调用
- [x] **深度思考模式** - Multi-step reasoning with tool execution loops
- [x] **流式输出** - 支持 agent 执行过程的流式响应

### 🚧 计划中功能
- [ ] **Redis Checkpointer** - 当前使用 MemorySaver 内存检查点
- [ ] **会话恢复机制** - 基于 thread_id 恢复历史对话
- [ ] **OpenTelemetry 追踪** - 可观测性监控
- [ ] **指标收集** - Token usage、latency 统计
- [ ] **A2A (Agent-to-Agent)** - 多智能体协作接口
- [ ] **动态工具注册** - 运行时注册新工具
- [ ] **多模态处理** - 图像/文档处理

## 许可证

Apache-2.0

## 贡献者

WeCode-AI Team
