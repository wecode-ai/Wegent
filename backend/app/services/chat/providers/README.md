# LLM Providers

This module provides a unified abstraction layer for different LLM providers (OpenAI, Claude, Gemini) with streaming support and tool calling capabilities.

## Overview

The providers module enables Chat Shell to work with multiple LLM backends through a consistent interface. Each provider handles the specific API format and streaming protocol of its respective service.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ChatService                            │
│                   (chat_service.py)                         │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    get_provider()                           │
│                    (factory.py)                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Selects provider based on model_config["model"]    │    │
│  │  - "openai" → OpenAIProvider                        │    │
│  │  - "claude" → ClaudeProvider                        │    │
│  │  - "gemini" → GeminiProvider                        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌───────────────┐  ┌──────────────┐  ┌──────────────┐
│ OpenAIProvider│  │ClaudeProvider│  │GeminiProvider│
│  (openai.py)  │  │ (claude.py)  │  │ (gemini.py)  │
└───────────────┘  └──────────────┘  └──────────────┘
          │               │               │
          └───────────────┼───────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     LLMProvider                             │
│                      (base.py)                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Abstract base class defining:                      │    │
│  │  - stream_chat(): Streaming chat completion         │    │
│  │  - format_messages(): Message formatting            │    │
│  │  - format_tools(): Tool formatting                  │    │
│  │  - _stream_sse(): Common SSE parsing                │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Files

| File                         | Description                              |
| ---------------------------- | ---------------------------------------- |
| [`__init__.py`](__init__.py) | Module exports                           |
| [`base.py`](base.py)         | Abstract base class and common utilities |
| [`factory.py`](factory.py)   | Provider factory function                |
| [`openai.py`](openai.py)     | OpenAI-compatible provider               |
| [`claude.py`](claude.py)     | Claude (Anthropic) provider              |
| [`gemini.py`](gemini.py)     | Gemini (Google) provider                 |

## Base Classes and Types

### ChunkType (Enum)

Defines the type of streaming chunk:

| Value       | Description        |
| ----------- | ------------------ |
| `CONTENT`   | Text content chunk |
| `TOOL_CALL` | Tool call chunk    |
| `ERROR`     | Error chunk        |
| `DONE`      | Stream completion  |

### StreamChunk (Dataclass)

Unified streaming chunk representation:

```python
@dataclass
class StreamChunk:
    type: ChunkType
    content: str = ""
    tool_call: dict[str, Any] | None = None
    error: str | None = None
```

### ProviderConfig (Dataclass)

Configuration for LLM provider:

```python
@dataclass
class ProviderConfig:
    api_key: str
    base_url: str
    model_id: str
    default_headers: dict[str, Any] = field(default_factory=dict)
    timeout: float = 300.0
    max_tokens: int = 4096
```

### LLMProvider (Abstract Base Class)

Abstract interface that all providers must implement:

```python
class LLMProvider(ABC):
    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Return the provider name."""
        pass

    @abstractmethod
    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        cancel_event: asyncio.Event,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream chat completion from the LLM."""
        pass

    @abstractmethod
    def format_messages(self, messages: list[dict[str, Any]]) -> Any:
        """Format messages for this provider's API."""
        pass

    @abstractmethod
    def format_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Format tools for this provider's API."""
        pass
```

## Providers

### OpenAIProvider

Supports OpenAI and OpenAI-compatible APIs (e.g., Azure OpenAI, local LLMs with OpenAI-compatible endpoints).

**Features:**

- Standard OpenAI chat completions API
- Vision support (for supported endpoints)
- Tool calling with function format

**API Format:**

- Endpoint: `{base_url}/chat/completions`
- Auth: `Authorization: Bearer {api_key}`
- Messages: OpenAI format (role, content)
- Tools: OpenAI function format

### ClaudeProvider

Supports Anthropic's Claude API.

**Features:**

- Claude Messages API
- Vision support with base64 images
- Tool calling with input_schema format

**API Format:**

- Endpoint: `{base_url}/v1/messages`
- Auth: `x-api-key: {api_key}`
- Messages: Claude format (system separate, content blocks)
- Tools: Claude format with `input_schema`

### GeminiProvider

Supports Google's Gemini API.

**Features:**

- Gemini generateContent API
- Vision support with inline_data
- Tool calling with function_declarations

**API Format:**

- Endpoint: `{base_url}/v1beta/models/{model}:streamGenerateContent`
- Auth: `x-goog-api-key: {api_key}`
- Messages: Gemini format (contents with parts)
- Tools: Gemini format with `function_declarations`

## Usage

### Basic Usage

```python
from app.services.chat.providers import get_provider
import httpx

async with httpx.AsyncClient() as client:
    model_config = {
        "model": "openai",  # or "claude", "gemini"
        "api_key": "your-api-key",
        "base_url": "https://api.openai.com/v1",
        "model_id": "gpt-4",
    }

    provider = get_provider(model_config, client)

    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ]

    cancel_event = asyncio.Event()

    async for chunk in provider.stream_chat(messages, cancel_event):
        if chunk.type == ChunkType.CONTENT:
            print(chunk.content, end="")
        elif chunk.type == ChunkType.ERROR:
            print(f"Error: {chunk.error}")
```

### With Tool Calling

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                },
                "required": ["location"],
            },
        },
    }
]

async for chunk in provider.stream_chat(messages, cancel_event, tools=tools):
    if chunk.type == ChunkType.TOOL_CALL:
        # Handle tool call
        tool_call = chunk.tool_call
        print(f"Tool: {tool_call.get('name')}, Args: {tool_call.get('arguments')}")
```

## Message Format Conversion

Each provider converts the standard OpenAI-style message format to its native format:

### OpenAI (Pass-through)

```python
# Input
{"role": "user", "content": "Hello"}

# Output (same)
{"role": "user", "content": "Hello"}
```

### Claude

```python
# Input
{"role": "user", "content": "Hello"}

# Output
{"role": "user", "content": [{"type": "text", "text": "Hello"}]}
```

### Gemini

```python
# Input
{"role": "user", "content": "Hello"}

# Output
{"role": "user", "parts": [{"text": "Hello"}]}
```

## Tool Format Conversion

### OpenAI (Pass-through)

```python
# Input/Output
{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "...",
        "parameters": {...}
    }
}
```

### Claude

```python
# Output
{
    "name": "get_weather",
    "description": "...",
    "input_schema": {...}
}
```

### Gemini

```python
# Output (wrapped in function_declarations)
{
    "name": "get_weather",
    "description": "...",
    "parameters": {...}
}
```

## Vision Support

All providers support vision inputs with automatic format conversion:

### Input Format (OpenAI-style)

```python
{
    "role": "user",
    "content": [
        {"type": "text", "text": "What's in this image?"},
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,..."}
        }
    ]
}
```

### Provider-specific Conversion

- **OpenAI**: Pass-through (if endpoint supports vision)
- **Claude**: Converts to `{"type": "image", "source": {"type": "base64", ...}}`
- **Gemini**: Converts to `{"inline_data": {"mime_type": "...", "data": "..."}}`

## Error Handling

Errors are returned as `StreamChunk` with `type=ChunkType.ERROR`:

```python
async for chunk in provider.stream_chat(messages, cancel_event):
    if chunk.type == ChunkType.ERROR:
        logger.error(f"Provider error: {chunk.error}")
        # Handle error appropriately
```

## Adding a New Provider

To add support for a new LLM provider:

1. Create a new file (e.g., `newprovider.py`)
2. Implement the `LLMProvider` abstract class
3. Add the provider to `factory.py`
4. Export from `__init__.py`

```python
# newprovider.py
class NewProvider(LLMProvider):
    @property
    def provider_name(self) -> str:
        return "newprovider"

    async def stream_chat(self, messages, cancel_event, tools=None):
        # Implement streaming logic
        pass

    def format_messages(self, messages):
        # Convert to provider's format
        pass

    def format_tools(self, tools):
        # Convert tools to provider's format
        pass
```

```python
# factory.py
from app.services.chat.providers.newprovider import NewProvider

def get_provider(model_config, client):
    model_type = model_config.get("model", "openai")

    if model_type == "newprovider":
        return NewProvider(config, client)
    # ... existing providers
```
