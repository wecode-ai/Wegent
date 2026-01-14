# Weibo Skill - Developer Documentation

This document provides technical details for developers working with the Weibo skill.

## Overview

The Weibo skill enables AI agents to interact with Weibo social media data through MCP (Model Context Protocol) servers. Unlike traditional skills that bundle tool implementations, this skill relies on external MCP servers for tool execution.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ User configures Ghost with mcpServers.weiboServer           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent loads "weibo" skill via load_skill()                  │
│ → SKILL.md declares: mcpServers: [weiboServer]             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Chat Shell MCP Loader (chat_shell/tools/mcp/loader.py)     │
│ → Extracts Ghost.spec.mcpServers                            │
│ → Filters to only weiboServer (declared by skill)          │
│ → Applies variable substitution (${{user.weibo_token}})    │
│ → Connects to MCP server                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ MCP Server exposes tools:                                   │
│ - getUserTimeline                                           │
│ - getStatus                                                 │
│ - convertMid                                                │
│ - getStatusShowBatch                                        │
│ - getUserInfo                                               │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Skill Package Structure

```
backend/init_data/skills/weibo/
├── SKILL.md          # Skill definition and documentation
└── README.md         # This file (developer documentation)
```

**Note**: Unlike provider-based skills (e.g., mermaid-diagram), the Weibo skill does NOT include:
- `provider.py` - Tools come from MCP server
- Custom tool implementations - All tools are MCP-provided

### 2. SKILL.md Metadata

The `mcpServers` field in SKILL.md metadata declares which MCP servers this skill requires:

```yaml
---
mcpServers:
  - weiboServer
---
```

This tells the system to:
1. Look for `weiboServer` in Ghost's `spec.mcpServers`
2. Connect to that server when the skill is loaded
3. Make the server's tools available to the agent

### 3. MCP Server Configuration

Users configure MCP servers in their Ghost specification:

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: weibo-analyst-ghost
spec:
  skills:
    - weibo
  mcpServers:
    weiboServer:
      type: streamable-http
      transport: streamable_http
      url: https://weibo-api.example.com
      headers:
        Authorization: Bearer ${{user.weibo_token}}
```

### 4. Variable Substitution

The system automatically substitutes variables in MCP configurations using `shared/utils/mcp_utils.py`:

```python
# Example substitution context from task data:
{
  "user": {
    "id": 123,
    "name": "zhangsan",
    "weibo_token": "secret_token_123"
  }
}

# Before substitution:
"Authorization": "Bearer ${{user.weibo_token}}"

# After substitution:
"Authorization": "Bearer secret_token_123"
```

Supported placeholder patterns:
- `${{user.weibo_token}}` - Nested access with dot notation
- `${{user.id}}` - Any scalar value
- `${{workspace.repo_name}}` - Access to workspace data
- `${{bot.0.name}}` - Array index access (for lists)

## Implementation Details

### How MCP Tools Are Loaded

1. **Task Creation**: User creates a task with a Team that references a Bot → Ghost → skills: [weibo]

2. **Chat Config Builder** (`backend/app/services/chat/config/chat_config.py`):
   - Extracts skill metadata from Ghost
   - Builds skill_configs for the session

3. **MCP Loader** (`chat_shell/chat_shell/tools/mcp/loader.py`):
   - Called by `load_mcp_tools(task_id, bot_name, bot_namespace, task_data)`
   - Loads Ghost's `mcpServers` via backend API
   - Merges with backend `CHAT_MCP_SERVERS` setting
   - Applies variable substitution using task_data
   - Connects to MCP servers
   - Registers tools in agent's tool registry

4. **Runtime**: LLM calls MCP tools like `getUserTimeline()` directly

### Error Handling

MCP connection errors are handled gracefully:

```python
try:
    client = MCPClient(merged_servers, task_data=task_data)
    await client.connect()
except Exception as e:
    logger.error(f"Failed to connect to MCP servers: {e}")
    return None  # Task continues without MCP tools
```

**Design Decision**: MCP failures do NOT crash the entire task. The agent continues with built-in tools only.

## Testing

### Unit Tests

Test variable substitution logic:

```python
# shared/tests/test_mcp_utils.py
def test_replace_weibo_token():
    mcp_config = {
        "weiboServer": {
            "headers": {
                "Authorization": "Bearer ${{user.weibo_token}}"
            }
        }
    }
    task_data = {"user": {"weibo_token": "secret123"}}

    result = replace_mcp_server_variables(mcp_config, task_data)
    assert result["weiboServer"]["headers"]["Authorization"] == "Bearer secret123"
```

### Integration Tests

Test end-to-end skill loading with MCP:

```python
# chat_shell/tests/test_weibo_skill_integration.py
async def test_weibo_skill_with_mcp(mock_weibo_mcp_server):
    # Create task with weibo skill
    # Mock MCP server responses
    # Verify tools are callable
    pass
```

### Manual Testing

1. Create a Ghost with Weibo skill and MCP configuration
2. Create a Bot referencing the Ghost
3. Create a Team with the Bot
4. Create a Task with the Team
5. In chat, trigger the skill and verify MCP tools are available

## Common Issues

### Issue: "MCP server 'weiboServer' is not available"

**Cause**: Ghost's `spec.mcpServers` doesn't contain `weiboServer`

**Solution**: Add the server configuration to Ghost YAML

### Issue: "401 Unauthorized" from MCP server

**Cause**: Invalid or expired token in `${{user.weibo_token}}`

**Solution**: Update user's Weibo API token in their profile or configuration

### Issue: Variable substitution not working

**Cause**:
- Incorrect placeholder syntax (use `${{path}}` not `${path}`)
- Variable path doesn't exist in task_data

**Solution**:
- Check placeholder syntax
- Verify the path exists: `logger.debug(f"task_data: {task_data}")`

## Adding New MCP Tools

If the Weibo MCP server adds new tools, simply update SKILL.md to document them. No code changes needed in Wegent since tools are dynamically registered from the MCP server.

## Related Files

| File | Purpose |
|------|---------|
| `backend/init_data/skills/weibo/SKILL.md` | Skill definition and user documentation |
| `chat_shell/chat_shell/tools/mcp/loader.py` | MCP server loading logic |
| `shared/utils/mcp_utils.py` | Variable substitution utilities |
| `chat_shell/chat_shell/tools/mcp/__init__.py` | MCPClient implementation |
| `backend/app/services/chat/config/chat_config.py` | Chat configuration builder |
| `backend/app/schemas/kind.py` | Ghost and Skill CRD schemas |

## Future Enhancements

1. **Skill-Level MCP Config**: Allow skills to provide default MCP server configurations
2. **MCP Server Discovery**: Automatic discovery of MCP servers from a registry
3. **Tool Filtering**: Allow skills to specify which MCP tools to expose
4. **Caching**: Cache MCP responses for frequently accessed data
5. **Monitoring**: Add metrics for MCP server health and response times

## Security Considerations

1. **Token Storage**: Weibo tokens should be encrypted in the database
2. **Variable Isolation**: Ensure task_data only contains safe values for substitution
3. **MCP Server Validation**: Validate MCP server URLs to prevent SSRF attacks
4. **Rate Limiting**: Implement per-user rate limiting for MCP calls
5. **Audit Logging**: Log all MCP tool calls for security auditing

## Contributing

When modifying the Weibo skill:

1. Update SKILL.md with new tool documentation
2. Add usage examples for new features
3. Update this README.md if architecture changes
4. Add tests for new functionality
5. Follow the code style guide in AGENTS.md

## References

- [Skill System Architecture](../../../docs/en/concepts/skill-system.md)
- [Ghost YAML Specification](../../../docs/en/reference/yaml-specification.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [Weibo API Documentation](https://open.weibo.com/wiki/)
