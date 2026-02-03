# Chat Shell Protocol Types and LLM Call Flow

This document describes the protocol types supported by Chat Shell and the complete flow of LLM (Large Language Model) calls.

## Overview

Chat Shell is a lightweight AI chat engine that supports multiple LLM providers through a unified interface. It uses LangChain as the abstraction layer and LangGraph for agent orchestration.

### Key Dependencies

| Component | Library | Version |
|-----------|---------|---------|
| LLM Abstraction | langchain-core | >=0.3.0 |
| Agent Framework | langgraph | >=1.0.0 |
| OpenAI Provider | langchain-openai | >=1.0.0 |
| Anthropic Provider | langchain-anthropic | >=1.0.0 |
| Google Provider | langchain-google-genai | >=2.0.0 |
| Token Counting | litellm | (unified) |

---

## Supported Protocol Types

Chat Shell supports three main protocol types (LLM providers):

### 1. OpenAI Protocol (`openai`)

**Library**: `langchain-openai` → `ChatOpenAI`

**Model Prefixes**: `gpt-*`, `o1-*`, `o3-*`, `chatgpt-*`

**Configuration Parameters**:
```python
{
    "model": "model_id",           # e.g., "gpt-4o", "o1-preview"
    "api_key": "api_key",
    "base_url": "custom_endpoint", # Optional, for OpenAI-compatible APIs
    "temperature": 1.0,
    "max_tokens": "max_tokens",
    "streaming": True/False,
    "use_responses_api": True/False,  # Enable Responses API
    "include": ["reasoning.encrypted_content"],  # For reasoning models
}
```

**Special Features**:
- **OpenAI-Compatible APIs**: Acts as the default fallback for unknown models, supporting any OpenAI-compatible endpoint
- **Responses API**: Enabled via `api_format: "responses"` for models like GPT-5.x
- **Reasoning Models**: Special handling for `o1-*` and `o3-*` models with reasoning content

**Context Windows**:
| Model | Context Window | Max Output |
|-------|----------------|------------|
| gpt-4o | 128,000 | 16,384 |
| gpt-4o-mini | 128,000 | 16,384 |
| gpt-4-turbo | 128,000 | 4,096 |
| o1 | 200,000 | 100,000 |
| o3 | 200,000 | 100,000 |

---

### 2. Anthropic Protocol (`anthropic`)

**Library**: `langchain-anthropic` → `ChatAnthropic`

**Model Prefixes**: `claude-*`

**Configuration Parameters**:
```python
{
    "model": "model_id",           # e.g., "claude-3-5-sonnet-20241022"
    "api_key": "api_key",
    "anthropic_api_url": "base_url",  # Optional custom endpoint
    "temperature": 1.0,
    "max_tokens": "max_tokens",
    "streaming": True/False,
    "model_kwargs": {
        "extra_headers": {}        # For prompt caching beta
    }
}
```

**Special Features**:
- **Prompt Caching**: Supports Anthropic's prompt caching feature (90% cost reduction on cached tokens)
- **Proxy Support**: Can use dummy API key when using custom `base_url` proxy

**Context Windows**:
| Model | Context Window | Max Output |
|-------|----------------|------------|
| claude-3-5-sonnet | 200,000 | 8,192 |
| claude-3-5-haiku | 200,000 | 8,192 |
| claude-sonnet-4 | 200,000 | 64,000 |
| claude-opus-4 | 200,000 | 32,000 |

---

### 3. Google/Gemini Protocol (`google`)

**Library**: `langchain-google-genai` → `ChatGoogleGenerativeAI`

**Model Prefixes**: `gemini-*`

**Configuration Parameters**:
```python
{
    "model": "model_id",               # e.g., "gemini-2.0-flash"
    "google_api_key": "api_key",
    "base_url": "custom_endpoint",     # Optional
    "temperature": 1.0,
    "max_output_tokens": "max_tokens", # Note: different param name
    "streaming": True/False,
    "additional_headers": {}           # Custom headers
}
```

**Special Features**:
- **Massive Context Windows**: Supports up to 2M tokens (gemini-1.5-pro)
- **Multimodal Support**: Native support for images and other media
- **Proxy Support**: Can use dummy API key when using custom `base_url` proxy

**Context Windows**:
| Model | Context Window | Max Output |
|-------|----------------|------------|
| gemini-1.5-pro | 2,097,152 | 8,192 |
| gemini-1.5-flash | 1,048,576 | 8,192 |
| gemini-2.0-flash | 1,048,576 | 8,192 |

---

## Provider Detection Logic

Chat Shell automatically detects the provider based on model type or model ID:

```python
# Priority 1: Check model_type alias
_PROVIDER_ALIASES = {
    "openai": "openai",
    "gpt": "openai",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "google": "google",
    "gemini": "google",
}

# Priority 2: Check model_id prefix
_PROVIDER_PATTERNS = [
    (("gpt-", "o1-", "o3-", "chatgpt-"), "openai"),
    (("claude-",), "anthropic"),
    (("gemini-",), "google"),
]

# Priority 3: Default to OpenAI (for OpenAI-compatible APIs)
```

---

## Complete LLM Call Flow

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Client (Frontend/Backend)                       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ POST /v1/response
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Layer (FastAPI)                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ResponseRequest Schema                                              │    │
│  │  - model_config: ModelConfig (model_id, api_key, base_url, etc.)    │    │
│  │  - input: InputConfig (text/messages/content)                        │    │
│  │  - system: System prompt                                             │    │
│  │  - tools: ToolsConfig (builtin, MCP, skills)                        │    │
│  │  - features: FeaturesConfig (deep_thinking, streaming, etc.)        │    │
│  │  - metadata: Metadata (task_id, user_id, etc.)                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ Convert to ChatRequest
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Chat Service                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatService.chat()                                                  │    │
│  │  1. Create StreamingCore for SSE emission                           │    │
│  │  2. Acquire resources (rate limiting)                               │    │
│  │  3. Call _process_chat()                                            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Context Preparation                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatContext.prepare()                                               │    │
│  │  1. Load chat history (from storage)                                │    │
│  │  2. Build system prompt (with enhancements)                         │    │
│  │  3. Create extra tools:                                              │    │
│  │     - MCP tools (from mcp_servers config)                           │    │
│  │     - Knowledge base tool                                            │    │
│  │     - Load skill tool                                                │    │
│  │     - Silent exit tool (for subscriptions)                          │    │
│  │  4. Return ContextResult                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Chat Agent                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatAgent.stream()                                                  │    │
│  │  1. Create AgentConfig                                               │    │
│  │  2. Build messages (history + current + system prompt)              │    │
│  │  3. Apply message compression (if needed)                           │    │
│  │  4. Create LangGraphAgentBuilder                                     │    │
│  │  5. Stream tokens                                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Model Factory                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LangChainModelFactory.create_from_config()                         │    │
│  │  1. Detect provider (openai/anthropic/google)                       │    │
│  │  2. Build provider-specific params                                   │    │
│  │  3. Instantiate LangChain model class:                              │    │
│  │     - ChatOpenAI (OpenAI)                                            │    │
│  │     - ChatAnthropic (Anthropic)                                      │    │
│  │     - ChatGoogleGenerativeAI (Google)                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LangGraph Agent Builder                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LangGraphAgentBuilder._build_agent()                               │    │
│  │  1. Create prompt_modifier (for skill prompts)                      │    │
│  │  2. Create model_configurator (for dynamic tools)                   │    │
│  │  3. Call langgraph.prebuilt.create_react_agent()                    │    │
│  │     - model: LLM instance (with tool binding)                       │    │
│  │     - tools: All available tools                                     │    │
│  │     - checkpointer: MemorySaver (optional)                          │    │
│  │     - prompt: Prompt modifier function                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LangGraphAgentBuilder.stream_tokens()                              │    │
│  │  1. Convert messages to LangChain format                            │    │
│  │  2. Call agent.astream_events() with recursion_limit                │    │
│  │  3. Process events:                                                  │    │
│  │     - on_chat_model_start: Track TTFT                               │    │
│  │     - on_chat_model_stream: Yield tokens + reasoning                │    │
│  │     - on_chat_model_end: Log completion                             │    │
│  │     - on_tool_start: Notify callback                                │    │
│  │     - on_tool_end: Notify callback                                  │    │
│  │     - on_chain_end: Extract final content                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LLM Provider API                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Provider-specific API call (via LangChain)                         │    │
│  │                                                                      │    │
│  │  OpenAI:      https://api.openai.com/v1/chat/completions           │    │
│  │  Anthropic:   https://api.anthropic.com/v1/messages                │    │
│  │  Google:      https://generativelanguage.googleapis.com/v1/models  │    │
│  │                                                                      │    │
│  │  Returns: Streaming chunks with content/tool_calls                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SSE Response Stream                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Event Types:                                                        │    │
│  │  - response.start: Response initiated                               │    │
│  │  - content.delta: Token chunk                                       │    │
│  │  - reasoning.delta: Reasoning content (DeepSeek R1 etc.)           │    │
│  │  - tool.start: Tool execution started                               │    │
│  │  - tool.done: Tool execution completed                              │    │
│  │  - response.done: Response completed with usage stats              │    │
│  │  - response.cancelled: Cancelled by user                            │    │
│  │  - response.error: Error occurred                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Sequence Diagram

```
Client          API             ChatService      ChatContext      ChatAgent       ModelFactory     LangGraph        LLM Provider
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

## Gemini Protocol Deep Dive

### Overview

The Gemini protocol uses Google's Generative AI API through the `langchain-google-genai` library. It has some unique characteristics compared to OpenAI and Anthropic.

### Key Differences

| Aspect | OpenAI/Anthropic | Gemini |
|--------|------------------|--------|
| Max Output Param | `max_tokens` | `max_output_tokens` |
| API Key Param | `api_key` | `google_api_key` |
| Custom Headers | `model_kwargs.extra_headers` | `additional_headers` |
| Context Window | 128K-200K | Up to 2M tokens |

### Model Factory Implementation

```python
# From chat_shell/models/factory.py

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
        "max_output_tokens": cfg.get("max_tokens"),  # Note: different param name
        "streaming": kw.get("streaming", False),
        "additional_headers": cfg.get("default_headers") or None,
    },
},
```

### Gemini API Call Flow

```
1. Model Factory receives model_config with model_id="gemini-*"

2. Provider detection:
   - _detect_provider("", "gemini-2.0-flash") → "google"

3. Parameter mapping:
   - model_config["api_key"] → google_api_key
   - model_config["max_tokens"] → max_output_tokens
   - model_config["default_headers"] → additional_headers

4. ChatGoogleGenerativeAI instance created

5. LangGraph binds tools to model:
   - llm.bind_tools(tools)

6. Streaming call:
   - agent.astream_events() internally calls Google Generative AI API
   - Google API endpoint: https://generativelanguage.googleapis.com/v1/models/{model}:streamGenerateContent

7. Response handling:
   - on_chat_model_stream events yield content chunks
   - Tool calls are extracted and executed
   - Final response assembled from chunks
```

### Gemini-Specific Considerations

1. **Large Context Windows**: Gemini models support massive context windows (up to 2M tokens for gemini-1.5-pro), which may require special handling for message compression thresholds.

2. **Token Counting**: Uses LiteLLM's unified token counter which supports Gemini models through the Google tokenizer.

3. **Multimodal Support**: Native support for images in the message content via the standard `image_url` format.

4. **Proxy Support**: When using a custom `base_url` (proxy), a dummy API key can be provided to satisfy validation requirements.

5. **Streaming**: Full streaming support via `astream_events()`, same as other providers.

### Configuration Example

```python
# Model CRD spec example for Gemini
model_config = {
    "model_id": "gemini-2.0-flash",
    "model": "google",  # or "gemini"
    "api_key": "your-google-api-key",
    "base_url": None,  # Use default Google endpoint
    "default_headers": {},
    "context_window": 1048576,  # 1M tokens
    "max_output_tokens": 8192,
}

# API request example
request = ResponseRequest(
    model_config=ModelConfig(
        model_id="gemini-2.0-flash",
        model="google",
        api_key="your-google-api-key",
    ),
    input=InputConfig(text="Hello, how are you?"),
    features=FeaturesConfig(streaming=True),
)
```

---

## Message Compression

Chat Shell includes automatic message compression when the conversation approaches context limits.

### Compression Configuration

```python
MODEL_CONTEXT_LIMITS = {
    # Gemini models have much larger contexts
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

### Compression Thresholds

- **Trigger Threshold**: 90% of available context (85% for unknown models)
- **Target Threshold**: 70% of available context (65% for unknown models)

### Compression Strategies

1. **Attachment Truncation**: Truncate long attachments to 50K characters
2. **Middle Message Pruning**: Keep first N and last M messages, prune middle
3. **Token-based Pruning**: Remove messages to meet target token count

---

## Tool Integration

### Tool Types

1. **Built-in Tools**: WebSearch, KnowledgeBase, FileReader, FileList
2. **MCP Tools**: External tools via Model Context Protocol
3. **Skill Tools**: Dynamically loaded via LoadSkillTool

### Tool Execution Flow

```
1. LangGraph ReAct agent decides to call a tool
2. on_tool_start event emitted
3. Tool function executed
4. Tool result returned to agent
5. on_tool_end event emitted
6. Agent continues with tool result in context
```

### Dynamic Tool Selection

```python
# LoadSkillTool enables dynamic tool selection
def configure_model(state, config):
    # Get currently available skill tools
    available_skill_tools = load_skill_tool.get_available_tools()
    
    # Combine base tools with available skill tools
    selected_tools = base_tools + available_skill_tools
    
    return llm.bind_tools(selected_tools)
```

---

## Error Handling

### Error Types

| Error | Description | SSE Event |
|-------|-------------|-----------|
| GraphRecursionError | Tool call limit reached | Final response generated |
| SilentExitException | Silent exit requested | response.done with silent_exit=true |
| API Error | Provider API error | response.error |
| Cancellation | User cancelled | response.cancelled |

### Tool Limit Handling

When `max_iterations` is reached, the agent asks the model to provide a final response without further tool calls:

```python
TOOL_LIMIT_REACHED_MESSAGE = """[SYSTEM NOTICE] Tool call limit reached.
Please provide your final response based on the information gathered so far.
Do NOT attempt to call any more tools."""
```

---

## Related Documentation

- [AGENTS.md](../../../AGENTS.md) - Project overview and coding guidelines
- [Chat Shell README](../../../chat_shell/README.md) - Chat Shell module documentation
- [Model CRD](../concepts/model-crd.md) - Model Custom Resource Definition
