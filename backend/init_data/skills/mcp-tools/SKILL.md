---
description: "Load external MCP (Model Context Protocol) tools on demand. Use this skill when you need specialized tools for web search, database access, file operations, or any MCP-compatible service. Loading this skill will dynamically connect to configured MCP servers and make their tools available."
displayName: "MCP Tools"
version: "1.0.0"
author: "Wegent Team"
tags: ["mcp", "tools", "external-services", "integration"]
bindShells: ["Chat"]
provider:
  module: provider
  class: MCPToolProvider
tools:
  - name: load_mcp_tools
    provider: mcp-tools
    config:
      timeout: 60
  - name: invoke_mcp_tool
    provider: mcp-tools
    config:
      timeout: 60
---

# MCP Tools - Dynamic External Tool Loading

This skill enables on-demand loading of MCP (Model Context Protocol) tools from configured external services.

## Overview

MCP (Model Context Protocol) is a standard protocol for connecting AI agents to external tools and services. This skill allows you to dynamically load tools from MCP servers configured in the environment.

**Key Benefits:**
- **Token Efficiency**: Tools are only loaded when needed, reducing initial prompt size
- **Flexible Integration**: Connect to any MCP-compatible service
- **Dynamic Discovery**: Available tools are discovered at runtime

## When to Use

Load this skill when you need to:
- Search the web or access external APIs
- Query databases or external data sources
- Perform file operations on remote systems
- Access any tool provided by configured MCP servers

**Note**: The specific tools available depend on the MCP servers configured in the `CHAT_MCP_SERVERS` environment variable.

## Available Tool

### `load_mcp_tools`

Connects to configured MCP servers and loads all available tools.

**Parameters:**
- `server_names` (optional): List of specific MCP server names to load. If not provided, loads tools from all configured servers.

**Returns:**
- On success: Confirmation message with list of loaded tools and their descriptions
- On error: Error message explaining what went wrong

**Example Usage:**

```json
{
  "name": "load_mcp_tools",
  "arguments": {}
}
```

Load specific servers only:
```json
{
  "name": "load_mcp_tools",
  "arguments": {
    "server_names": ["web-search", "database"]
  }
}
```

### `invoke_mcp_tool`

Invokes a previously loaded MCP tool by name.

**Parameters:**
- `tool_name` (required): The name of the MCP tool to invoke
- `arguments` (optional): Arguments to pass to the MCP tool as a JSON object

**Returns:**
- The result from the MCP tool execution
- Error message if the tool is not found or execution fails

**Example Usage:**

```json
{
  "name": "invoke_mcp_tool",
  "arguments": {
    "tool_name": "web_search",
    "arguments": {
      "query": "latest AI news"
    }
  }
}
```

## Post-Loading Behavior

After successfully calling `load_mcp_tools`:

1. **New tools become available**: All tools from the connected MCP servers are discovered
2. **Tool information is stored**: Tools are cached for the session duration
3. **Use invoke_mcp_tool**: Call `invoke_mcp_tool` with the tool name and arguments to use any loaded tool

**Example workflow:**

1. User asks: "Search for the latest news about AI"
2. You recognize this requires web search capability
3. Call `load_mcp_tools` to load available tools
4. Review the list of loaded tools
5. Call `invoke_mcp_tool` with the appropriate tool name (e.g., `web_search`)
6. Return results to the user

## Configuration

MCP servers are configured via the `CHAT_MCP_SERVERS` environment variable. The format is:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "sse|stdio|streamable-http",
      "url": "https://mcp-server.example.com",
      "headers": {
        "Authorization": "Bearer ${{user.token}}"
      }
    }
  }
}
```

**Supported connection types:**
- `sse`: Server-Sent Events (for web-based servers)
- `stdio`: Standard I/O (for local process servers)
- `streamable-http`: HTTP streaming (default)

**Variable substitution:**
- Use `${{path}}` syntax for dynamic values
- Common variables: `${{user.name}}`, `${{user.token}}`, `${{git_repo}}`

## Error Handling

If `load_mcp_tools` fails:

1. **No servers configured**: Check if `CHAT_MCP_SERVERS` is set
2. **Connection timeout**: Server may be unavailable or slow
3. **Authentication error**: Check credentials in server configuration
4. **Partial failure**: Some servers may fail while others succeed - you'll still get tools from successful connections

## Best Practices

1. **Load once per conversation**: Tools persist for the session, no need to reload
2. **Check available tools**: After loading, check what tools are available before using them
3. **Handle errors gracefully**: If loading fails, explain the limitation to the user
4. **Use specific servers**: If you know which server you need, specify it to reduce connection overhead

## Technical Notes

- MCP connections are established asynchronously
- Tools are wrapped with timeout protection (60 seconds per call)
- Failed individual servers don't prevent other servers from loading
- Connection state is maintained for the conversation duration

## Limitations

- Tools are only available after explicit loading via `load_mcp_tools`
- Server availability depends on network and external service status
- Some tools may require specific authentication or permissions
