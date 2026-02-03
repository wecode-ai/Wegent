# Chat Shell 协议类型与大模型调用流程

本文档描述了 Chat Shell 支持的协议类型以及大模型（LLM）调用的完整流程。

## 概述

Chat Shell 是一个轻量级 AI 聊天引擎，通过统一接口支持多种 LLM 提供商。它使用 LangChain 作为抽象层，使用 LangGraph 进行 Agent 编排。

### 核心依赖

| 组件 | 库 | 版本 |
|-----|-----|------|
| LLM 抽象层 | langchain-core | >=0.3.0 |
| Agent 框架 | langgraph | >=1.0.0 |
| OpenAI 提供商 | langchain-openai | >=1.0.0 |
| Anthropic 提供商 | langchain-anthropic | >=1.0.0 |
| Google 提供商 | langchain-google-genai | >=2.0.0 |
| Token 计数 | litellm | (统一) |

---

## 支持的协议类型

Chat Shell 支持三种主要的协议类型（LLM 提供商）：

### 1. OpenAI 协议 (`openai`)

**库**: `langchain-openai` → `ChatOpenAI`

**模型前缀**: `gpt-*`, `o1-*`, `o3-*`, `chatgpt-*`

**配置参数**:
```python
{
    "model": "model_id",           # 例如 "gpt-4o", "o1-preview"
    "api_key": "api_key",
    "base_url": "custom_endpoint", # 可选，用于 OpenAI 兼容 API
    "temperature": 1.0,
    "max_tokens": "max_tokens",
    "streaming": True/False,
    "use_responses_api": True/False,  # 启用 Responses API
    "include": ["reasoning.encrypted_content"],  # 用于推理模型
}
```

**特殊功能**:
- **OpenAI 兼容 API**: 作为未知模型的默认后备，支持任何 OpenAI 兼容端点
- **Responses API**: 通过 `api_format: "responses"` 启用，用于 GPT-5.x 等模型
- **推理模型**: 对 `o1-*` 和 `o3-*` 模型提供特殊的推理内容处理

**上下文窗口**:
| 模型 | 上下文窗口 | 最大输出 |
|-----|-----------|---------|
| gpt-4o | 128,000 | 16,384 |
| gpt-4o-mini | 128,000 | 16,384 |
| gpt-4-turbo | 128,000 | 4,096 |
| o1 | 200,000 | 100,000 |
| o3 | 200,000 | 100,000 |

---

### 2. Anthropic 协议 (`anthropic`)

**库**: `langchain-anthropic` → `ChatAnthropic`

**模型前缀**: `claude-*`

**配置参数**:
```python
{
    "model": "model_id",           # 例如 "claude-3-5-sonnet-20241022"
    "api_key": "api_key",
    "anthropic_api_url": "base_url",  # 可选自定义端点
    "temperature": 1.0,
    "max_tokens": "max_tokens",
    "streaming": True/False,
    "model_kwargs": {
        "extra_headers": {}        # 用于 prompt caching beta
    }
}
```

**特殊功能**:
- **Prompt 缓存**: 支持 Anthropic 的 prompt 缓存功能（缓存 token 可节省 90% 成本）
- **代理支持**: 使用自定义 `base_url` 代理时可使用虚拟 API 密钥

**上下文窗口**:
| 模型 | 上下文窗口 | 最大输出 |
|-----|-----------|---------|
| claude-3-5-sonnet | 200,000 | 8,192 |
| claude-3-5-haiku | 200,000 | 8,192 |
| claude-sonnet-4 | 200,000 | 64,000 |
| claude-opus-4 | 200,000 | 32,000 |

---

### 3. Google/Gemini 协议 (`google`)

**库**: `langchain-google-genai` → `ChatGoogleGenerativeAI`

**模型前缀**: `gemini-*`

**配置参数**:
```python
{
    "model": "model_id",               # 例如 "gemini-2.0-flash"
    "google_api_key": "api_key",
    "base_url": "custom_endpoint",     # 可选
    "temperature": 1.0,
    "max_output_tokens": "max_tokens", # 注意：参数名不同
    "streaming": True/False,
    "additional_headers": {}           # 自定义请求头
}
```

**特殊功能**:
- **超大上下文窗口**: 支持高达 2M tokens（gemini-1.5-pro）
- **多模态支持**: 原生支持图片和其他媒体
- **代理支持**: 使用自定义 `base_url` 代理时可使用虚拟 API 密钥

**上下文窗口**:
| 模型 | 上下文窗口 | 最大输出 |
|-----|-----------|---------|
| gemini-1.5-pro | 2,097,152 | 8,192 |
| gemini-1.5-flash | 1,048,576 | 8,192 |
| gemini-2.0-flash | 1,048,576 | 8,192 |

---

## 提供商检测逻辑

Chat Shell 根据模型类型或模型 ID 自动检测提供商：

```python
# 优先级 1: 检查 model_type 别名
_PROVIDER_ALIASES = {
    "openai": "openai",
    "gpt": "openai",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "google": "google",
    "gemini": "google",
}

# 优先级 2: 检查 model_id 前缀
_PROVIDER_PATTERNS = [
    (("gpt-", "o1-", "o3-", "chatgpt-"), "openai"),
    (("claude-",), "anthropic"),
    (("gemini-",), "google"),
]

# 优先级 3: 默认使用 OpenAI（用于 OpenAI 兼容 API）
```

---

## 完整的大模型调用流程

### 架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              客户端 (Frontend/Backend)                       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ POST /v1/response
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API 层 (FastAPI)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ResponseRequest Schema                                              │    │
│  │  - model_config: ModelConfig (model_id, api_key, base_url 等)       │    │
│  │  - input: InputConfig (text/messages/content)                        │    │
│  │  - system: 系统提示词                                                │    │
│  │  - tools: ToolsConfig (builtin, MCP, skills)                        │    │
│  │  - features: FeaturesConfig (deep_thinking, streaming 等)           │    │
│  │  - metadata: Metadata (task_id, user_id 等)                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 转换为 ChatRequest
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           聊天服务 (Chat Service)                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatService.chat()                                                  │    │
│  │  1. 创建 StreamingCore 用于 SSE 发送                                 │    │
│  │  2. 获取资源（限流）                                                  │    │
│  │  3. 调用 _process_chat()                                            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           上下文准备 (Context Preparation)                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatContext.prepare()                                               │    │
│  │  1. 加载聊天历史（从存储）                                            │    │
│  │  2. 构建系统提示词（带增强）                                          │    │
│  │  3. 创建额外工具:                                                    │    │
│  │     - MCP 工具（从 mcp_servers 配置）                                │    │
│  │     - 知识库工具                                                     │    │
│  │     - 加载技能工具                                                   │    │
│  │     - 静默退出工具（用于订阅）                                        │    │
│  │  4. 返回 ContextResult                                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           聊天 Agent (Chat Agent)                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatAgent.stream()                                                  │    │
│  │  1. 创建 AgentConfig                                                 │    │
│  │  2. 构建消息（历史 + 当前 + 系统提示词）                              │    │
│  │  3. 应用消息压缩（如需要）                                            │    │
│  │  4. 创建 LangGraphAgentBuilder                                       │    │
│  │  5. 流式传输 token                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        模型工厂 (Model Factory)                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LangChainModelFactory.create_from_config()                         │    │
│  │  1. 检测提供商 (openai/anthropic/google)                             │    │
│  │  2. 构建提供商特定参数                                                │    │
│  │  3. 实例化 LangChain 模型类:                                         │    │
│  │     - ChatOpenAI (OpenAI)                                            │    │
│  │     - ChatAnthropic (Anthropic)                                      │    │
│  │     - ChatGoogleGenerativeAI (Google)                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LangGraph Agent 构建器                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LangGraphAgentBuilder._build_agent()                               │    │
│  │  1. 创建 prompt_modifier（用于技能提示词）                            │    │
│  │  2. 创建 model_configurator（用于动态工具）                           │    │
│  │  3. 调用 langgraph.prebuilt.create_react_agent()                    │    │
│  │     - model: LLM 实例（带工具绑定）                                   │    │
│  │     - tools: 所有可用工具                                            │    │
│  │     - checkpointer: MemorySaver（可选）                              │    │
│  │     - prompt: 提示词修改函数                                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LangGraphAgentBuilder.stream_tokens()                              │    │
│  │  1. 转换消息为 LangChain 格式                                        │    │
│  │  2. 调用 agent.astream_events() 并设置 recursion_limit              │    │
│  │  3. 处理事件:                                                        │    │
│  │     - on_chat_model_start: 追踪 TTFT                                │    │
│  │     - on_chat_model_stream: 产出 tokens + 推理内容                  │    │
│  │     - on_chat_model_end: 记录完成                                   │    │
│  │     - on_tool_start: 通知回调                                       │    │
│  │     - on_tool_end: 通知回调                                         │    │
│  │     - on_chain_end: 提取最终内容                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LLM 提供商 API                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  提供商特定 API 调用（通过 LangChain）                                │    │
│  │                                                                      │    │
│  │  OpenAI:      https://api.openai.com/v1/chat/completions           │    │
│  │  Anthropic:   https://api.anthropic.com/v1/messages                │    │
│  │  Google:      https://generativelanguage.googleapis.com/v1/models  │    │
│  │                                                                      │    │
│  │  返回: 带有 content/tool_calls 的流式块                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SSE 响应流                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  事件类型:                                                           │    │
│  │  - response.start: 响应开始                                         │    │
│  │  - content.delta: Token 块                                          │    │
│  │  - reasoning.delta: 推理内容（DeepSeek R1 等）                      │    │
│  │  - tool.start: 工具执行开始                                         │    │
│  │  - tool.done: 工具执行完成                                          │    │
│  │  - response.done: 响应完成，含使用统计                               │    │
│  │  - response.cancelled: 用户取消                                     │    │
│  │  - response.error: 发生错误                                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 时序图

```
客户端          API             ChatService      ChatContext      ChatAgent       ModelFactory     LangGraph        LLM 提供商
  │              │                   │               │               │                │               │                 │
  │─POST /v1/response────────────────►               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │─ResponseRequest───►               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │─prepare()─────►               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │◄─ContextResult─               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │─────────────────stream()──────►                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │─create_from_config()──────────►│                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │◄──ChatModel────│               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │─build_agent()──────────────────►                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │─stream_tokens()────────────────►                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │                │               │─astream()──────►
  │              │                   │               │               │                │               │                 │
  │◄─SSE: response.start─────────────│               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │◄─chunk──────────────────────────────────────────│
  │◄─SSE: content.delta──────────────│               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │◄─tool_call─────────────────────────────────────│
  │◄─SSE: tool.start─────────────────│               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │──execute_tool()─►               │                 │
  │              │                   │               │               │◄─tool_result────               │                 │
  │◄─SSE: tool.done──────────────────│               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │              │                   │               │               │◄─final_chunk───────────────────────────────────│
  │◄─SSE: content.delta──────────────│               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
  │◄─SSE: response.done──────────────│               │               │                │               │                 │
  │              │                   │               │               │                │               │                 │
```

---

## Gemini 协议深入分析

### 概述

Gemini 协议通过 `langchain-google-genai` 库使用 Google 的 Generative AI API。与 OpenAI 和 Anthropic 相比，它有一些独特的特点。

### 主要差异

| 方面 | OpenAI/Anthropic | Gemini |
|-----|------------------|--------|
| 最大输出参数 | `max_tokens` | `max_output_tokens` |
| API 密钥参数 | `api_key` | `google_api_key` |
| 自定义请求头 | `model_kwargs.extra_headers` | `additional_headers` |
| 上下文窗口 | 128K-200K | 最高 2M tokens |

### 模型工厂实现

```python
# 来自 chat_shell/models/factory.py

"google": {
    "class": ChatGoogleGenerativeAI,
    "params": lambda cfg, kw: {
        "model": cfg["model_id"],
        "google_api_key": (
            cfg["api_key"]
            if cfg["api_key"]
            else ("dummy" if cfg.get("base_url") else None)
        ),
        "base_url": cfg.get("base_url") or None,
        "temperature": kw.get("temperature", 1.0),
        "max_output_tokens": cfg.get("max_tokens"),  # 注意：参数名不同
        "streaming": kw.get("streaming", False),
        "additional_headers": cfg.get("default_headers") or None,
    },
},
```

### Gemini API 调用流程

```
1. Model Factory 收到 model_config，其中 model_id="gemini-*"

2. 提供商检测:
   - _detect_provider("", "gemini-2.0-flash") → "google"

3. 参数映射:
   - model_config["api_key"] → google_api_key
   - model_config["max_tokens"] → max_output_tokens
   - model_config["default_headers"] → additional_headers

4. 创建 ChatGoogleGenerativeAI 实例

5. LangGraph 将工具绑定到模型:
   - llm.bind_tools(tools)

6. 流式调用:
   - agent.astream_events() 内部调用 Google Generative AI API
   - Google API 端点: https://generativelanguage.googleapis.com/v1/models/{model}:streamGenerateContent

7. 响应处理:
   - on_chat_model_stream 事件产出内容块
   - 提取并执行工具调用
   - 从块中组装最终响应
```

### Gemini 特有注意事项

1. **大型上下文窗口**: Gemini 模型支持超大上下文窗口（gemini-1.5-pro 最高 2M tokens），可能需要特殊处理消息压缩阈值。

2. **Token 计数**: 使用 LiteLLM 的统一 token 计数器，通过 Google 分词器支持 Gemini 模型。

3. **多模态支持**: 通过标准 `image_url` 格式原生支持消息内容中的图片。

4. **代理支持**: 使用自定义 `base_url`（代理）时，可以提供虚拟 API 密钥以满足验证要求。

5. **流式传输**: 通过 `astream_events()` 完全支持流式传输，与其他提供商相同。

### 配置示例

```python
# Gemini 的 Model CRD spec 示例
model_config = {
    "model_id": "gemini-2.0-flash",
    "model": "google",  # 或 "gemini"
    "api_key": "your-google-api-key",
    "base_url": None,  # 使用默认 Google 端点
    "default_headers": {},
    "context_window": 1048576,  # 1M tokens
    "max_output_tokens": 8192,
}

# API 请求示例
request = ResponseRequest(
    model_config=ModelConfig(
        model_id="gemini-2.0-flash",
        model="google",
        api_key="your-google-api-key",
    ),
    input=InputConfig(text="你好，最近怎么样？"),
    features=FeaturesConfig(streaming=True),
)
```

---

## 消息压缩

当对话接近上下文限制时，Chat Shell 会自动进行消息压缩。

### 压缩配置

```python
MODEL_CONTEXT_LIMITS = {
    # Gemini 模型有更大的上下文
    "gemini-1.5-pro": ModelContextConfig(
        context_window=2097152,  # 2M tokens
        output_tokens=8192
    ),
    "gemini-2.0-flash": ModelContextConfig(
        context_window=1048576,  # 1M tokens
        output_tokens=8192
    ),
}
```

### 压缩阈值

- **触发阈值**: 可用上下文的 90%（未知模型为 85%）
- **目标阈值**: 可用上下文的 70%（未知模型为 65%）

### 压缩策略

1. **附件截断**: 将长附件截断到 50K 字符
2. **中间消息修剪**: 保留前 N 条和后 M 条消息，修剪中间部分
3. **基于 Token 的修剪**: 移除消息以满足目标 token 数

---

## 工具集成

### 工具类型

1. **内置工具**: WebSearch、KnowledgeBase、FileReader、FileList
2. **MCP 工具**: 通过 Model Context Protocol 的外部工具
3. **技能工具**: 通过 LoadSkillTool 动态加载

### 工具执行流程

```
1. LangGraph ReAct agent 决定调用工具
2. 发出 on_tool_start 事件
3. 执行工具函数
4. 将工具结果返回给 agent
5. 发出 on_tool_end 事件
6. Agent 继续使用上下文中的工具结果
```

### 动态工具选择

```python
# LoadSkillTool 启用动态工具选择
def configure_model(state, config):
    # 获取当前可用的技能工具
    available_skill_tools = load_skill_tool.get_available_tools()
    
    # 将基础工具与可用技能工具组合
    selected_tools = base_tools + available_skill_tools
    
    return llm.bind_tools(selected_tools)
```

---

## 错误处理

### 错误类型

| 错误 | 描述 | SSE 事件 |
|-----|------|---------|
| GraphRecursionError | 达到工具调用限制 | 生成最终响应 |
| SilentExitException | 请求静默退出 | response.done，silent_exit=true |
| API Error | 提供商 API 错误 | response.error |
| Cancellation | 用户取消 | response.cancelled |

### 工具限制处理

当达到 `max_iterations` 时，agent 会要求模型在不进行更多工具调用的情况下提供最终响应：

```python
TOOL_LIMIT_REACHED_MESSAGE = """[系统通知] 达到工具调用限制。
请根据已收集的信息提供最终响应。
不要尝试调用更多工具。"""
```

---

## 相关文档

- [AGENTS.md](../../../AGENTS.md) - 项目概述和编码规范
- [Chat Shell README](../../../chat_shell/README.md) - Chat Shell 模块文档
- [Model CRD](../concepts/model-crd.md) - Model 自定义资源定义
