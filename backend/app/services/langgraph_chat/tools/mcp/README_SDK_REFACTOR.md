# MCP SDK Refactoring

## Overview

This document explains the refactoring of our MCP (Model Context Protocol) client implementation to leverage the official `mcp` SDK from PyPI instead of custom implementation.

## Why Refactor to Official SDK?

### Current Implementation (client.py)
Our custom implementation in `client.py` manually handles:
- JSON-RPC protocol for stdio transport
- Process management with asyncio.subprocess
- Request/response serialization
- Error handling and timeouts
- Multiple transport protocols (stdio, SSE, HTTP)

**Problems with Custom Implementation:**
1. **Maintenance burden**: Must manually track MCP spec changes
2. **Edge cases**: May miss subtle protocol details
3. **Testing complexity**: Requires extensive mocking and testing
4. **Reinventing the wheel**: Duplicating work already done by SDK
5. **Performance**: May not be as optimized as official implementation

### Official SDK Benefits (client_sdk.py)

The official `mcp` SDK (version 1.22.0, already in pyproject.toml) provides:

1. **Robust Implementation**
   - Well-tested by Anthropic
   - Handles edge cases (process crashes, timeouts, malformed responses)
   - Follows MCP specification exactly

2. **Better Resource Management**
   - Proper cleanup with context managers
   - Handles process lifecycle correctly
   - Memory-efficient streaming

3. **Future-Proof**
   - Automatically gets MCP spec updates
   - Bug fixes from upstream
   - New features as SDK evolves

4. **Less Code to Maintain**
   - Stdio implementation reduced from ~90 lines to ~60 lines
   - No manual JSON-RPC handling
   - No manual process management

## Implementation Comparison

### Stdio Transport: Before (Custom)

```python
# Custom implementation (client.py)
class StdioMCPSession(MCPSession):
    async def connect(self):
        self.process = await asyncio.create_subprocess_exec(
            self.command, *self.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=merged_env,
        )
        self.tools = await self.list_tools()

    async def _send_request(self, method, params):
        # Manual JSON-RPC request construction
        request = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        })
        self.process.stdin.write((request + "\n").encode())
        await self.process.stdin.drain()

        # Manual timeout handling
        try:
            response_line = await asyncio.wait_for(
                self.process.stdout.readline(),
                timeout=self.read_timeout
            )
        except asyncio.TimeoutError:
            if self.process:
                self.process.terminate()
            raise RuntimeError(...)

        response = json.loads(response_line.decode())
        if "error" in response:
            raise RuntimeError(f"MCP error: {response['error']}")
        return response.get("result", {})
```

**Issues:**
- Manual process lifecycle management
- Custom JSON-RPC serialization
- Manual timeout handling
- Risk of process zombies
- No automatic cleanup on errors

### Stdio Transport: After (Official SDK)

```python
# Using official SDK (client_sdk.py)
class StdioMCPSession(MCPSession):
    async def connect(self):
        # Official SDK handles all the complexity
        server_params = StdioServerParameters(
            command=self.command,
            args=self.args,
            env=self.env
        )

        self._stdio_context = stdio_client(server_params)
        self._read_stream, self._write_stream = await self._stdio_context.__aenter__()

        self._sdk_session = ClientSession(self._read_stream, self._write_stream)
        await self._sdk_session.initialize()

        self.tools = await self.list_tools()

    async def list_tools(self):
        # SDK handles all protocol details
        result = await self._sdk_session.list_tools()
        return [MCPTool(...) for tool in result.tools]

    async def call_tool(self, tool_name, arguments):
        # SDK handles serialization, timeouts, errors
        result = await self._sdk_session.call_tool(tool_name, arguments)
        return {
            "content": [{"type": c.type, "text": c.text} for c in result.content],
            "isError": result.isError or False,
        }
```

**Improvements:**
- ✅ SDK manages process lifecycle
- ✅ Automatic JSON-RPC handling
- ✅ Built-in timeout and error handling
- ✅ Proper cleanup with context managers
- ✅ Less code, fewer bugs

## Migration Strategy

### Phase 1: Side-by-Side Implementation (CURRENT)
- [x] Install official `mcp` SDK (already in pyproject.toml)
- [x] Create `client_sdk.py` with SDK-based implementation
- [x] Keep existing `client.py` for backward compatibility
- [x] Document differences and benefits

### Phase 2: Testing & Validation (TODO)
- [ ] Add unit tests for `client_sdk.py`
- [ ] Add integration tests with real MCP servers
- [ ] Performance comparison: custom vs SDK
- [ ] Memory usage profiling

### Phase 3: Gradual Rollout (TODO)
- [ ] Add feature flag to switch between implementations
- [ ] Test in development environment
- [ ] Monitor for regressions
- [ ] Update `session.py` to use `client_sdk.py`

### Phase 4: Cleanup (TODO)
- [ ] Remove custom `client.py` implementation
- [ ] Update documentation
- [ ] Update tests to only test SDK version

## API Compatibility

The new `client_sdk.py` maintains the same public API as `client.py`:

```python
# Both implementations support:
client = MCPClient()

# Stdio connection
session = await client.connect_stdio(
    "my-server",
    "npx",
    ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
)

# SSE connection (custom protocol, SDK doesn't support yet)
session = await client.connect_sse(
    "my-server",
    "http://localhost:8080/sse"
)

# Tool operations
tools = await session.list_tools()
result = await session.call_tool("tool_name", {"arg": "value"})
```

## Key SDK Classes Used

### From `mcp` package:

1. **`StdioServerParameters`**: Configuration for stdio servers
   ```python
   StdioServerParameters(
       command="npx",
       args=["-y", "@modelcontextprotocol/server-filesystem"],
       env={"HOME": "/home/user"}
   )
   ```

2. **`stdio_client`**: Context manager for stdio transport
   ```python
   async with stdio_client(server_params) as (read_stream, write_stream):
       # Streams are managed automatically
   ```

3. **`ClientSession`**: Main client session class
   ```python
   session = ClientSession(read_stream, write_stream)
   await session.initialize()

   # High-level methods
   tools = await session.list_tools()
   result = await session.call_tool("name", arguments)
   ```

## Performance Expectations

Based on official SDK design:

| Metric | Custom Implementation | Official SDK | Improvement |
|--------|----------------------|--------------|-------------|
| Code Maintenance | High (manual sync with spec) | Low (automatic updates) | ✅ Significant |
| Edge Case Handling | Medium (best effort) | High (well-tested) | ✅ Improved |
| Process Cleanup | Manual (risk of zombies) | Automatic (context managers) | ✅ Safer |
| Memory Usage | Unknown | Optimized | ⚖️ To be measured |
| Latency | Unknown | Optimized | ⚖️ To be measured |

## Testing Plan

### Unit Tests
```python
@pytest.mark.asyncio
async def test_stdio_connection_with_sdk():
    """Test stdio connection using official SDK."""
    client = MCPClient()
    session = await client.connect_stdio(
        "test-server",
        "python",
        ["test_mcp_server.py"]
    )

    assert session.server_name == "test-server"
    assert len(session.tools) > 0

    await client.disconnect("test-server")

@pytest.mark.asyncio
async def test_tool_execution_with_sdk():
    """Test tool execution via SDK."""
    client = MCPClient()
    session = await client.connect_stdio("test-server", "python", ["server.py"])

    result = await session.call_tool("echo", {"message": "hello"})

    assert not result["isError"]
    assert result["content"][0]["text"] == "hello"

    await client.disconnect_all()
```

### Integration Tests
- Test with real MCP servers (filesystem, fetch, etc.)
- Test error conditions (server crashes, timeouts)
- Test cleanup on exceptions

## Migration Checklist

- [x] Create `client_sdk.py` with official SDK
- [x] Document benefits and migration plan
- [ ] Write comprehensive tests for SDK implementation
- [ ] Add feature flag for gradual rollout
- [ ] Performance benchmarks (custom vs SDK)
- [ ] Update `session.py` to use SDK version
- [ ] Deploy to staging environment
- [ ] Monitor production metrics
- [ ] Remove old `client.py` implementation
- [ ] Update all documentation

## Rollback Plan

If issues arise during migration:
1. Feature flag allows instant rollback to `client.py`
2. Both implementations remain in codebase during Phase 2-3
3. No API changes, so upstream code unaffected

## Conclusion

Migrating to the official MCP SDK provides:
- ✅ **Less maintenance**: No manual MCP spec tracking
- ✅ **Better reliability**: Well-tested, handles edge cases
- ✅ **Future-proof**: Automatic updates and bug fixes
- ✅ **Simpler code**: Less code to maintain and debug

The refactored `client_sdk.py` is ready for testing and gradual rollout.
