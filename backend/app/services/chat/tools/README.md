# Chat Shell Tools Module

This module provides a unified tool system for Chat Shell, enabling LLM function calling with built-in tools and external MCP server integration.

## Architecture

```
tools/
├── __init__.py      # Public API exports
├── base.py          # Tool dataclass and ToolRegistry
├── builtin.py       # Built-in tools (web search)
├── mcp.py           # MCP server integration
└── README.md        # This file
```

## Module Responsibilities

| Module       | Responsibility                                                              |
| ------------ | --------------------------------------------------------------------------- |
| `base.py`    | Defines `Tool` dataclass and `ToolRegistry` for tool management             |
| `builtin.py` | Provides built-in tools like web search                                     |
| `mcp.py`     | Manages MCP client connections and provides tools from external MCP servers |

## Usage

### Basic Usage

```python
from app.services.chat.tools import Tool, ToolRegistry, get_web_search_tool

# Create a custom tool
my_tool = Tool(
    name="my_tool",
    description="Does something useful",
    parameters={
        "type": "object",
        "properties": {
            "input": {"type": "string", "description": "Input text"}
        },
        "required": ["input"]
    },
    fn=my_function  # async or sync callable
)

# Use built-in web search tool
search_tool = get_web_search_tool()

# Create a registry with tools
registry = ToolRegistry([my_tool, search_tool])

# Format tools for LLM provider
openai_tools = registry.format_for_provider("openai")
claude_tools = registry.format_for_provider("claude")
```

### MCP Tools

MCP (Model Context Protocol) tools are loaded from external servers configured via environment variables.

```python
from app.services.chat.tools import get_mcp_session, cleanup_mcp_session, is_mcp_enabled

# Check if MCP is enabled
if is_mcp_enabled():
    # Get MCP session for a task
    session = await get_mcp_session(task_id=123)
    if session:
        # Get tools from MCP servers
        mcp_tools = session.get_tools()

        # Clean up when done
        await cleanup_mcp_session(task_id=123)
```

## Configuration

### Web Search

Web search requires the search service to be configured. See `backend/app/services/search/README.md`.

### MCP Servers

Configure MCP servers via environment variables:

```bash
# Enable MCP tools
CHAT_MCP_ENABLED=True

# Configure MCP servers (JSON format)
CHAT_MCP_SERVERS='{
  "mcpServers": {
    "image-gen": {
      "type": "sse",
      "url": "http://localhost:8080/sse",
      "headers": {"Authorization": "Bearer xxx"}
    },
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}'
```

### MCP Server Types

| Type              | Description                    | Required Fields                   |
| ----------------- | ------------------------------ | --------------------------------- |
| `stdio`           | Local process via stdin/stdout | `command`, optional `args`, `env` |
| `sse`             | HTTP Server-Sent Events        | `url`, optional `headers`         |
| `streamable-http` | HTTP streaming                 | `url`, optional `headers`         |

## Tool Interface

All tools must have these attributes:

```python
@dataclass
class Tool:
    name: str                    # Unique tool name
    description: str             # Description for LLM
    parameters: dict[str, Any]   # JSON Schema for parameters
    fn: Callable[..., Any]       # Async or sync callable
```

The `fn` callable should:

- Accept keyword arguments matching the parameters schema
- Return a string result (or any value that can be converted to string)
- Handle errors gracefully

## Provider Formats

`ToolRegistry.format_for_provider()` supports:

| Provider | Format                                                   |
| -------- | -------------------------------------------------------- |
| `openai` | `{"type": "function", "function": {...}}`                |
| `claude` | `{"name": ..., "description": ..., "input_schema": ...}` |
| `gemini` | `{"name": ..., "description": ..., "parameters": ...}`   |

## Session Lifecycle

MCP sessions are managed per-task:

1. **Task Start**: `get_mcp_session(task_id)` creates connections to all configured MCP servers
2. **Tool Discovery**: Tools are listed from each server and wrapped as `Tool` instances
3. **Tool Execution**: During conversation, LLM can call tools via the session
4. **Task End**: `cleanup_mcp_session(task_id)` closes all connections

This ensures:

- Isolation between different users/tasks
- Proper resource cleanup
- No connection leaks

## Tool Naming Convention

MCP tools are named with the pattern: `{server_name}__{tool_name}`

For example, if you have a server named `image-gen` with a tool `generate_image`, the tool will be available as `image-gen__generate_image`.
