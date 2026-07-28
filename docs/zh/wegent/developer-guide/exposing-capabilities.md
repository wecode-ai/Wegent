---
sidebar_position: 15
---

# 对外暴露能力指南

本文档介绍 Wegent 项目中对外暴露功能能力的标准方式，以 Knowledge Base MCP 实现为例，说明如何让你的功能被 AI Agent 调用。

## 概述

Wegent 提供两种主要方式对外暴露能力：

| 方式 | 适用场景 | 复杂度 | 示例 |
|------|----------|--------|------|
| **Skill + MCP** | 复杂业务功能，需要多个 tools | 中等 | Knowledge Base、Interactive Form |
| **MCP Server Only** | 简单工具，无需 Skill 包装 | 低 | System MCP (silent_exit) |

推荐方式：**Skill + MCP**，因为 Skill 提供了：
- 用户可配置的界面
- 版本管理和权限控制
- 自动注入的 System Prompt
- 可复用的组件化设计

## 架构流程

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Skill 定义 (SKILL.md)                                        │
│     - 描述能力用途                                               │
│     - 配置 MCP Server 连接信息                                   │
│     - 提供使用说明和示例                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  2. MCP Server 实现                                              │
│     - 使用 FastMCP 创建 server                                   │
│     - 通过 @mcp_tool 装饰器注册 tools                            │
│     - 实现具体业务逻辑                                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  3. 注册与挂载                                                   │
│     - 应用启动时注册 tools                                       │
│     - 挂载到 FastAPI 路由                                        │
│     - 注入到 Execution Request                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  4. 运行时调用                                                   │
│     - Chat Shell / Executor 加载 Skill                           │
│     - MCP Client 连接到 Server                                   │
│     - LLM 根据 prompt 决定调用 tool                              │
└─────────────────────────────────────────────────────────────────┘
```

## 实现步骤

### 第一步：创建 Skill 定义

在 `backend/init_data/skills/{your-skill-name}/SKILL.md` 创建 Skill 定义：

```yaml
---
description: "功能描述，告诉 AI 什么时候使用这个 Skill"
displayName: "显示名称"
version: "1.0.0"
author: "Your Team"
tags: ["tag1", "tag2"]
bindShells:          # 可选：指定适用的 Shell 类型
  - Chat
  - Agno
  - ClaudeCode
mcpServers:          # MCP Server 配置
  your-server-name:
    type: streamable-http
    url: "${{backend_url}}/mcp/your-path/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Skill 使用说明

## 可用工具

- **tool_name**: 工具描述
  - param1: 参数说明
  - param2: 参数说明

## 使用示例

1. 首先调用 xxx：
   ```
   tool_name(param1="value")
   ```

2. 然后调用 yyy...

## 注意事项

- 重要提示 1
- 重要提示 2
```

**关键配置说明：**

- `mcpServers`: 定义 MCP Server 连接信息
  - `url`: 使用 `${{backend_url}}` 和 `${{task_token}}` 占位符，运行时由平台注入
  - `type`: 目前主要使用 `streamable-http`
- `bindShells`: 限制 Skill 只能在特定 Shell 类型中使用

### 第二步：实现 MCP Tools

在 `backend/app/mcp_server/tools/{your_module}.py` 实现 tools：

```python
from app.mcp_server.tools.decorator import mcp_tool
from app.mcp_server.auth import TaskTokenInfo

@mcp_tool(
    name="your_tool_name",           # Tool 名称，LLM 看到的名称
    description="Tool 描述，告诉 AI 这个 tool 的作用",
    server="your_server_name",       # 对应 SKILL.md 中的 mcpServers key
    param_descriptions={             # 参数描述，帮助 LLM 理解
        "param1": "参数1说明",
        "param2": "参数2说明",
    },
)
def your_tool_name(
    token_info: TaskTokenInfo,       # 必需：自动从 context 注入
    param1: str,
    param2: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Tool 的详细描述，会显示在 MCP schema 中。
    
    Args:
        token_info: Task token 信息，包含用户身份
        param1: 参数1
        param2: 参数2
    
    Returns:
        返回结果字典
    """
    db = SessionLocal()
    try:
        # 1. 获取用户信息
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}
        
        # 2. 执行业务逻辑
        result = your_service.do_something(
            db=db,
            user=user,
            param1=param1,
            param2=param2,
        )
        
        # 3. 返回结果
        return result.model_dump()
    
    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] Error: {e}", exc_info=True)
        return {"error": str(e)}
    finally:
        db.close()
```

**重要约定：**

1. **第一个参数必须是 `token_info: TaskTokenInfo`**
   - 它会自动从 MCP request context 注入
   - 不要在 `@mcp_tool` 的 `param_descriptions` 中描述它
   - 装饰器会自动将其从 MCP schema 中排除

2. **数据库会话管理**
   - 每个 tool 函数内部创建 `SessionLocal()`
   - 确保在 `finally` 块中关闭

3. **错误处理**
   - 业务错误返回 `{"error": "..."}`
   - 异常记录日志后返回错误信息

4. **返回值**
   - 返回字典，会被自动序列化为 JSON
   - Pydantic 模型使用 `.model_dump()`

### 第三步：注册 MCP Server

在 `backend/app/mcp_server/server.py` 添加 server 定义：

```python
# 1. 创建 FastMCP 实例
your_mcp_server = FastMCP(
    "wegent-your-server-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
)

# 2. 创建 context var（用于存储 request token）
_your_request_token_info: contextvars.ContextVar[Optional[TaskTokenInfo]] = (
    contextvars.ContextVar("_your_request_token_info", default=None)
)

# 3. 注册函数（导入 tools 模块触发装饰器）
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

# 4. 定义 McpAppSpec
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

# 5. 添加到 MCP_APP_SPECS
MCP_APP_SPECS = (
    _SYSTEM_MCP_SPEC,
    _KNOWLEDGE_MCP_SPEC,
    _YOUR_MCP_SPEC,  # 添加到这里
)

# 6. 添加配置生成函数（供 Skill 使用）
def get_mcp_your_config(backend_url: str, auth_token: str) -> Dict[str, Any]:
    return _build_streamable_http_config(
        name="wegent-your-server",
        url=f"{backend_url}/mcp/your-path/sse",
        auth_token=auth_token,
        timeout=300,
    )
```

### 第四步：Skill 自动注入

如果需要在用户选择特定功能时自动注入 Skill，在 `backend/app/services/chat/trigger/unified.py` 添加：

```python
SELECTED_FEATURE_PRELOAD_SKILL = "wegent-your-skill"

def _ensure_selected_feature_skill_priority(request: "ExecutionRequest") -> None:
    """确保选择特定功能时自动加载 Skill"""
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

## 装饰器详解

### @mcp_tool 参数

```python
@mcp_tool(
    # Tool 在 MCP 中的名称（LLM 看到的）
    name="tool_name",
    
    # Tool 描述（显示在 MCP schema 中）
    description="Tool description",
    
    # 所属 server，对应 SKILL.md 中的 mcpServers key
    server="knowledge",
    
    # 从 MCP schema 中排除的参数（默认排除 token_info）
    exclude_params=["token_info"],
    
    # 参数描述，帮助 LLM 理解参数用途
    param_descriptions={
        "param1": "Description of param1",
    },
    
    # 参数重命名（原始名 -> MCP 名）
    param_renames={
        "internal_name": "external_name",
    },
)
```

### 参数类型映射

装饰器自动将 Python 类型转换为 JSON Schema：

| Python 类型 | JSON Schema 类型 |
|------------|-----------------|
| `str` | `string` |
| `int` | `integer` |
| `float` | `number` |
| `bool` | `boolean` |
| `list` | `array` |
| `dict` | `object` |
| `Optional[T]` | `T` (非 required) |
| Pydantic Model | `object` |

## 完整示例

### 文件结构

```
backend/
├── init_data/skills/
│   └── wegent-example/
│       └── SKILL.md
├── app/mcp_server/
│   ├── server.py          # 添加 server 定义
│   ├── tool_registry.py   # 自动注册（已有）
│   └── tools/
│       ├── __init__.py    # 导出模块
│       └── example.py     # 实现 tools
└── app/services/
    └── example/           # 业务逻辑服务
        └── service.py
```

### SKILL.md 示例

```markdown
---
description: "Example skill for demonstrating capability exposure"
displayName: "示例能力"
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

# 示例能力

## 可用工具

- **list_items**: 列出所有项目
  - scope: 范围（"all", "personal"）
  
- **create_item**: 创建新项目
  - name: 项目名称
  - description: 项目描述

## 使用示例

```
list_items(scope="all")
create_item(name="My Item", description="A new item")
```
```

### Tool 实现示例

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
        
        # 调用业务逻辑
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

## 测试

### 手动测试 MCP Endpoint

```bash
# 1. 启动后端服务
uv run python -m app.main

# 2. 测试健康检查
curl http://localhost:8000/mcp/example/health

# 3. 使用 MCP Inspector 测试 tools
npx @anthropics/mcp-inspector
# 然后输入 http://localhost:8000/mcp/example/sse
```

### 单元测试

参考 `backend/tests/mcp_server/test_server_routes.py`：

```python
def test_your_tool():
    # 测试 tool 逻辑
    result = your_tool(
        token_info=mock_token_info,
        param1="value",
    )
    assert "error" not in result
    assert result["items"] is not None
```

## 最佳实践

1. **单一职责**：每个 tool 只做一件事
2. **幂等性**：相同的输入应该产生相同的结果
3. **错误处理**：始终返回错误信息而不是抛出异常
4. **权限检查**：使用 `token_info` 验证用户权限
5. **参数验证**：在 service 层做验证，返回清晰的错误信息
6. **日志记录**：记录所有错误和关键操作
7. **数据库会话**：每个 tool 独立管理会话，确保关闭
8. **超时设置**：根据操作复杂度设置合理的 timeout

## 参考实现

- **Knowledge MCP**: `backend/app/mcp_server/tools/knowledge.py`
- **Interactive Form MCP**: `backend/app/mcp_server/tools/interactive_form_question.py`
- **Skill 定义**: `backend/init_data/skills/wegent-knowledge/SKILL.md`
- **Server 注册**: `backend/app/mcp_server/server.py`
- **装饰器实现**: `backend/app/mcp_server/tools/decorator.py`
- **注册逻辑**: `backend/app/mcp_server/tool_registry.py`
