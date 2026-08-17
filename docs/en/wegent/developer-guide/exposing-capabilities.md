---
sidebar_position: 15
---

# Exposing Capabilities Guide

This document describes the standard way to expose functional capabilities in the Wegent project, using the Knowledge Base MCP implementation as an example to show how to make your features available to AI Agents.

## Overview

Wegent provides two main approaches for exposing capabilities:

| Approach | Use Case | Complexity | Example |
|----------|----------|------------|---------|
| **Skill + MCP** | Complex business features requiring multiple tools | Medium | Knowledge Base, Interactive Form |
| **MCP Server Only** | Simple tools without Skill wrapper | Low | System MCP (silent_exit) |

**Recommended approach: Skill + MCP**, because Skills provide:
- User-configurable interface
- Version management and permission control
- Auto-injected System Prompt
- Reusable component design

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Skill Definition (SKILL.md)                                  │
│     - Describe capability purpose                                │
│     - Configure MCP Server connection info                       │
│     - Provide usage instructions and examples                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  2. MCP Server Implementation                                    │
│     - Create server using FastMCP                                │
│     - Register tools via @mcp_tool decorator                     │
│     - Implement business logic                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  3. Registration and Mounting                                    │
│     - Register tools at application startup                      │
│     - Mount to FastAPI routes                                    │
│     - Inject into Execution Request                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  4. Runtime Invocation                                           │
│     - Chat Shell / Executor loads Skill                          │
│     - MCP Client connects to Server                              │
│     - LLM decides to invoke tool based on prompt                 │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Create Skill Definition

Create the Skill definition at `backend/init_data/skills/{your-skill-name}/SKILL.md`:

```yaml
---
description: "Describe when the AI should use this Skill"
displayName: "Display Name"
version: "1.0.0"
author: "Your Team"
tags: ["tag1", "tag2"]
bindShells:          # Optional: specify applicable Shell types
  - Chat
  - Agno
  - ClaudeCode
mcpServers:          # MCP Server configuration
  your-server-name:
    type: streamable-http
    url: "${{backend_url}}/mcp/your-path/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Skill Usage Instructions

## Available Tools

- **tool_name**: Tool description
  - param1: Parameter description
  - param2: Parameter description

## Usage Examples

1. First call xxx:
   ```
   tool_name(param1="value")
   ```

2. Then call yyy...

## Notes

- Important note 1
- Important note 2
```

**Key Configuration Notes:**

- `mcpServers`: Define MCP Server connection information
  - `url`: Use `${{backend_url}}` and `${{task_token}}` placeholders, injected at runtime by the platform
  - `type`: Currently mainly uses `streamable-http`
- `bindShells`: Restrict Skill to only work in specific Shell types

### Step 2: Implement MCP Tools

Implement tools in `backend/app/mcp_server/tools/{your_module}.py`:

```python
from app.mcp_server.tools.decorator import mcp_tool
from app.mcp_server.auth import TaskTokenInfo

@mcp_tool(
    name="your_tool_name",           # Tool name that LLM sees
    description="Tool description explaining what it does",
    server="your_server_name",       # Corresponds to mcpServers key in SKILL.md
    param_descriptions={             # Parameter descriptions to help LLM understand
        "param1": "Description of param1",
        "param2": "Description of param2",
    },
)
def your_tool_name(
    token_info: TaskTokenInfo,       # Required: auto-injected from context
    param1: str,
    param2: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Detailed description of the tool, displayed in MCP schema.
    
    Args:
        token_info: Task token info containing user identity
        param1: Parameter 1
        param2: Parameter 2
    
    Returns:
        Result dictionary
    """
    db = SessionLocal()
    try:
        # 1. Get user info
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}
        
        # 2. Execute business logic
        result = your_service.do_something(
            db=db,
            user=user,
            param1=param1,
            param2=param2,
        )
        
        # 3. Return result
        return result.model_dump()
    
    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] Error: {e}", exc_info=True)
        return {"error": str(e)}
    finally:
        db.close()
```

**Important Conventions:**

1. **First parameter must be `token_info: TaskTokenInfo`**
   - Automatically injected from MCP request context
   - Don't describe it in `@mcp_tool`'s `param_descriptions`
   - Decorator automatically excludes it from MCP schema

2. **Database Session Management**
   - Create `SessionLocal()` inside each tool function
   - Ensure it's closed in `finally` block

3. **Error Handling**
   - Business errors return `{"error": "..."}`
   - Exceptions are logged and return error message

4. **Return Values**
   - Return dict, automatically serialized to JSON
   - Use `.model_dump()` for Pydantic models

### Step 3: Register MCP Server

Add server definition in `backend/app/mcp_server/server.py`:

```python
# 1. Create FastMCP instance
your_mcp_server = FastMCP(
    "wegent-your-server-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
)

# 2. Create context var (for storing request token)
_your_request_token_info: contextvars.ContextVar[Optional[TaskTokenInfo]] = (
    contextvars.ContextVar("_your_request_token_info", default=None)
)

# 3. Registration function (import tools module to trigger decorators)
_your_tools_registered = False

def _register_your_tools() -> None:
    global _your_tools_registered
    if _your_tools_registered:
        return
    
    from app.mcp_server.tool_registry import register_tools_to_server
    from app.mcp_server.tools import your_module  # noqa: F401
    
    count = register_tools_to_server(your_mcp_server, "your_server_name")
    logger.info(f"[MCP:YourServer] Registered {count} tools")
    _your_tools_registered = True

def ensure_your_tools_registered() -> None:
    _register_your_tools()

# 4. Define McpAppSpec
_YOUR_MCP_SPEC = McpAppSpec(
    name="your_server_name",
    service_name="wegent-your-server-mcp",
    mount_path="/mcp/your-path",
    transport_path="/sse",
    server=your_mcp_server,
    token_context=_your_request_token_info,
    log_prefix="YourServer",
    include_root_metadata=True,
)

# 5. Add to MCP_APP_SPECS
MCP_APP_SPECS = (
    _SYSTEM_MCP_SPEC,
    _KNOWLEDGE_MCP_SPEC,
    _YOUR_MCP_SPEC,  # Add here
)

# 6. Add config generation function (for Skill usage)
def get_mcp_your_config(backend_url: str, auth_token: str) -> Dict[str, Any]:
    return _build_streamable_http_config(
        name="wegent-your-server",
        url=f"{backend_url}/mcp/your-path/sse",
        auth_token=auth_token,
        timeout=300,
    )
```

### Step 4: Auto-Inject Skill

If you need to auto-inject Skill when user selects a specific feature, add to `backend/app/services/chat/trigger/unified.py`:

```python
SELECTED_FEATURE_PRELOAD_SKILL = "wegent-your-skill"

def _ensure_selected_feature_skill_priority(request: "ExecutionRequest") -> None:
    """Ensure Skill is automatically loaded when specific feature is selected"""
    if not request.feature_enabled or not request.is_user_selected_feature:
        return
    
    preload_skills = list(request.preload_skills or [])
    if SELECTED_FEATURE_PRELOAD_SKILL not in preload_skills:
        preload_skills.append(SELECTED_FEATURE_PRELOAD_SKILL)
        request.preload_skills = preload_skills
    
    user_selected_skills = list(request.user_selected_skills or [])
    if SELECTED_FEATURE_PRELOAD_SKILL not in user_selected_skills:
        user_selected_skills.append(SELECTED_FEATURE_PRELOAD_SKILL)
        request.user_selected_skills = user_selected_skills
```

## Decorator Details

### @mcp_tool Parameters

```python
@mcp_tool(
    # Tool name in MCP (what LLM sees)
    name="tool_name",
    
    # Tool description (displayed in MCP schema)
    description="Tool description",
    
    # Belongs to server, corresponds to mcpServers key in SKILL.md
    server="knowledge",
    
    # Parameters to exclude from MCP schema (token_info excluded by default)
    exclude_params=["token_info"],
    
    # Parameter descriptions to help LLM understand parameter usage
    param_descriptions={
        "param1": "Description of param1",
    },
    
    # Parameter renaming (original_name -> MCP_name)
    param_renames={
        "internal_name": "external_name",
    },
)
```

### Parameter Type Mapping

The decorator automatically converts Python types to JSON Schema:

| Python Type | JSON Schema Type |
|------------|-----------------|
| `str` | `string` |
| `int` | `integer` |
| `float` | `number` |
| `bool` | `boolean` |
| `list` | `array` |
| `dict` | `object` |
| `Optional[T]` | `T` (not required) |
| Pydantic Model | `object` |

## Complete Example

### File Structure

```
backend/
├── init_data/skills/
│   └── wegent-example/
│       └── SKILL.md
├── app/mcp_server/
│   ├── server.py          # Add server definition
│   ├── tool_registry.py   # Auto-registration (existing)
│   └── tools/
│       ├── __init__.py    # Export modules
│       └── example.py     # Implement tools
└── app/services/
    └── example/           # Business logic service
        └── service.py
```

### SKILL.md Example

```markdown
---
description: "Example skill for demonstrating capability exposure"
displayName: "Example Capability"
version: "1.0.0"
author: "Wegent Team"
tags: ["example", "demo"]
mcpServers:
  example:
    type: streamable-http
    url: "${{backend_url}}/mcp/example/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---

# Example Capability

## Available Tools

- **list_items**: List all items
  - scope: Scope ("all", "personal")
  
- **create_item**: Create new item
  - name: Item name
  - description: Item description

## Usage Examples

```
list_items(scope="all")
create_item(name="My Item", description="A new item")
```
```

### Tool Implementation Example

```python
# backend/app/mcp_server/tools/example.py

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.models.user import User

logger = logging.getLogger(__name__)


def _get_user_from_token(db: Session, token_info: TaskTokenInfo) -> Optional[User]:
    return db.query(User).filter(User.id == token_info.user_id).first()


@mcp_tool(
    name="list_items",
    description="List all items accessible to the current user",
    server="example",
    param_descriptions={
        "scope": "Filter scope: 'all' or 'personal'",
    },
)
def list_items(
    token_info: TaskTokenInfo,
    scope: str = "all",
) -> Dict[str, Any]:
    """List all items."""
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found", "total": 0, "items": []}
        
        # Call business logic
        items = example_service.list_items(db, user, scope)
        
        return {
            "total": len(items),
            "items": [item.model_dump() for item in items],
        }
    except Exception as e:
        logger.error(f"[MCP] list_items error: {e}", exc_info=True)
        return {"error": str(e), "total": 0, "items": []}
    finally:
        db.close()


@mcp_tool(
    name="create_item",
    description="Create a new item",
    server="example",
    param_descriptions={
        "name": "Item name",
        "description": "Item description",
    },
)
def create_item(
    token_info: TaskTokenInfo,
    name: str,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a new item."""
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}
        
        result = example_service.create_item(
            db=db,
            user=user,
            name=name,
            description=description,
        )
        
        return result.model_dump()
    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] create_item error: {e}", exc_info=True)
        return {"error": str(e)}
    finally:
        db.close()
```

## Testing

### Manual MCP Endpoint Testing

```bash
# 1. Start backend service
uv run python -m app.main

# 2. Test health check
curl http://localhost:8000/mcp/example/health

# 3. Use MCP Inspector to test tools
npx @anthropics/mcp-inspector
# Then input http://localhost:8000/mcp/example/sse
```

### Unit Testing

Refer to `backend/tests/mcp_server/test_server_routes.py`:

```python
def test_your_tool():
    # Test tool logic
    result = your_tool(
        token_info=mock_token_info,
        param1="value",
    )
    assert "error" not in result
    assert result["items"] is not None
```

## Best Practices

1. **Single Responsibility**: Each tool does one thing
2. **Idempotency**: Same input should produce same result
3. **Error Handling**: Always return error info instead of throwing exceptions
4. **Permission Check**: Use `token_info` to verify user permissions
5. **Parameter Validation**: Do validation in service layer, return clear error messages
6. **Logging**: Log all errors and key operations
7. **Database Session**: Each tool independently manages session, ensure closure
8. **Timeout Setting**: Set reasonable timeout based on operation complexity

## Reference Implementations

- **Knowledge MCP**: `backend/app/mcp_server/tools/knowledge.py`
- **Interactive Form MCP**: `backend/app/mcp_server/tools/interactive_form_question.py`
- **Skill Definition**: `backend/init_data/skills/wegent-knowledge/SKILL.md`
- **Server Registration**: `backend/app/mcp_server/server.py`
- **Decorator Implementation**: `backend/app/mcp_server/tools/decorator.py`
- **Registration Logic**: `backend/app/mcp_server/tool_registry.py`
