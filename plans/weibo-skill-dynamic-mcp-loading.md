# Dynamic MCP Loading for Skills - Implementation Plan

## Current Status

✅ **Completed:**
- Added `mcpServers` field to backend `SkillSpec` schema
- Created comprehensive Weibo skill documentation
- Added unit tests for MCP variable substitution
- Updated skill-system documentation (EN/ZH)

⚠️ **In Progress:**
- Implementing dynamic MCP loading when `load_skill()` is called

## Architecture Overview

```
User calls load_skill("weibo")
    ↓
LoadSkillTool._run()
    ↓
Check skill_metadata["weibo"]["mcpServers"]  → ["weiboServer"]
    ↓
Call mcp_loader_callback(skill_name, mcpServerNames)
    ↓
MCP Loader filters Ghost.mcpServers to only weiboServer
    ↓
Connect to weiboServer MCP
    ↓
Register MCP tools (getUserTimeline, getStatus, etc.)
    ↓
Tools available to agent immediately
```

## Implementation Steps

### Step 1: Update chat_shell SkillSpec Schema

**File:** `chat_shell/chat_shell/schemas/kind.py`

Add `mcpServers` field to `SkillSpec` after line 150:

```python
class SkillSpec(BaseModel):
    """Skill specification"""

    description: str
    displayName: Optional[str] = None
    prompt: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None
    bindShells: Optional[List[str]] = None
    tools: Optional[List[SkillToolDeclaration]] = None
    provider: Optional[SkillProviderConfig] = None
    mcpServers: Optional[List[str]] = None  # ADD THIS LINE
```

### Step 2: Include mcpServers in skill_configs

**File:** `backend/app/services/chat/config/chat_config.py`

Around line 517 (after adding provider), add:

```python
# Include MCP servers if declared in skill
if skill_crd.spec.mcpServers:
    skill_data["mcpServers"] = skill_crd.spec.mcpServers
```

### Step 3: Extend LoadSkillTool

**File:** `chat_shell/chat_shell/tools/builtin/load_skill.py`

Add new attributes after line 71:

```python
# MCP loader callback for dynamic MCP server loading
# This callback is called when a skill with mcpServers is loaded
mcp_loader_callback: Optional[Any] = None
ghost_mcp_servers: dict[str, Any] = {}  # Ghost's mcpServers config
task_data: Optional[dict[str, Any]] = None  # Task data for variable substitution
```

Modify `_run()` method after line 108 to add MCP loading:

```python
# Mark skill as expanded for this turn and store the prompt
self._expanded_skills.add(skill_name)
self._loaded_skill_prompts[skill_name] = prompt

# Cache the display name
display_name = skill_info.get("displayName")
if display_name:
    self._skill_display_names[skill_name] = display_name

# NEW: Load MCP servers if skill declares them
skill_mcp_servers = skill_info.get("mcpServers", [])
if skill_mcp_servers and self.mcp_loader_callback:
    try:
        logger.info(
            "[LoadSkillTool] Skill '%s' requires MCP servers: %s",
            skill_name,
            skill_mcp_servers,
        )

        # Filter Ghost's mcpServers to only include skill's required servers
        filtered_mcp_servers = {
            name: config
            for name, config in self.ghost_mcp_servers.items()
            if name in skill_mcp_servers
        }

        if filtered_mcp_servers:
            # Call async loader callback
            import asyncio
            loop = asyncio.get_event_loop()
            new_tools = loop.create_task(
                self.mcp_loader_callback(
                    skill_name, filtered_mcp_servers, self.task_data
                )
            )
            # Note: Tools will be registered asynchronously
            logger.info(
                "[LoadSkillTool] Triggered async MCP loading for skill '%s'",
                skill_name,
            )
        else:
            logger.warning(
                "[LoadSkillTool] Skill '%s' requires MCP servers %s but none found in Ghost config",
                skill_name,
                skill_mcp_servers,
            )
    except Exception as e:
        logger.error(
            "[LoadSkillTool] Error loading MCP servers for skill '%s': %s",
            skill_name,
            str(e),
        )

# Return confirmation
return f"Skill '{skill_name}' has been loaded. The instructions have been added to the system prompt. Please follow them strictly."
```

###Step 4: Create MCP Loader Callback

**File:** `chat_shell/chat_shell/services/context.py`

Add method to ChatContext class (around line 300):

```python
async def _load_skill_mcp_servers(
    self,
    skill_name: str,
    mcp_servers_config: dict[str, Any],
    task_data: Optional[dict[str, Any]],
) -> list:
    """Load MCP servers dynamically when a skill is loaded.

    Args:
        skill_name: Name of the skill requesting MCP servers
        mcp_servers_config: Filtered MCP servers config from Ghost
        task_data: Task data for variable substitution

    Returns:
        List of new tools from MCP servers
    """
    from chat_shell.tools.mcp import MCPClient
    from shared.utils.mcp_utils import replace_mcp_server_variables

    logger.info(
        "[ChatContext] Loading MCP servers for skill '%s': %s",
        skill_name,
        list(mcp_servers_config.keys()),
    )

    try:
        # Apply variable substitution
        if task_data:
            mcp_servers_config = replace_mcp_server_variables(
                mcp_servers_config, task_data
            )

        # Create and connect MCP client
        client = MCPClient(mcp_servers_config, task_data=task_data)
        await client.connect()

        # Get tools from MCP client
        tools = client.get_tools()

        # Track client for cleanup
        self._mcp_clients.append(client)

        logger.info(
            "[ChatContext] Loaded %d tools from MCP for skill '%s'",
            len(tools),
            skill_name,
        )

        return tools

    except Exception as e:
        logger.error(
            "[ChatContext] Failed to load MCP servers for skill '%s': %s",
            skill_name,
            str(e),
        )
        return []
```

### Step 5: Pass Callback to LoadSkillTool

**File:** `chat_shell/chat_shell/tools/skill_factory.py`

Modify `prepare_load_skill_tool()` around line 66:

```python
# Create LoadSkillTool with the available skills
load_skill_tool = LoadSkillTool(
    user_id=user_id,
    skill_names=skill_names,
    skill_metadata=skill_metadata,
    mcp_loader_callback=mcp_loader_callback,  # NEW
    ghost_mcp_servers=ghost_mcp_servers,  # NEW
    task_data=task_data,  # NEW
)
```

Add parameters to function signature:

```python
def prepare_load_skill_tool(
    skill_names: list[str],
    user_id: int,
    skill_configs: list[dict] | None = None,
    mcp_loader_callback: Optional[Any] = None,  # NEW
    ghost_mcp_servers: Optional[dict[str, Any]] = None,  # NEW
    task_data: Optional[dict[str, Any]] = None,  # NEW
) -> Optional[Any]:
```

Also update skill_metadata building to include mcpServers:

```python
skill_metadata[name] = {
    "description": config.get("description", ""),
    "prompt": config.get("prompt", ""),
    "displayName": config.get("displayName", ""),
    "mcpServers": config.get("mcpServers", []),  # NEW
}
```

### Step 6: Update ChatContext to Pass Callback

**File:** `chat_shell/chat_shell/services/context.py`

Modify line 109 where `prepare_load_skill_tool` is called:

```python
self._load_skill_tool = prepare_load_skill_tool(
    skill_names=self._request.skill_names,
    user_id=self._request.user_id,
    skill_configs=self._request.skill_configs,
    mcp_loader_callback=self._load_skill_mcp_servers,  # NEW
    ghost_mcp_servers=self._request.mcp_servers or {},  # NEW
    task_data=self._request.task_data,  # NEW
)
```

## Testing Plan

### Manual Testing

1. **Create Ghost with Weibo skill:**
```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: weibo-test
spec:
  systemPrompt: "You are a Weibo analyst"
  skills:
    - weibo
  mcpServers:
    weiboServer:
      type: streamable-http
      url: https://weibo-api.example.com
      headers:
        Authorization: Bearer ${{user.weibo_token}}
```

2. **Create Bot and Team referencing the Ghost**

3. **Start chat session and trigger skill:**
```
User: "Search for posts from user @techblogger"

Expected flow:
- LLM calls load_skill("weibo")
- System loads MCP server dynamically
- LLM can now call getUserInfo(), getUserTimeline(), etc.
```

### Unit Tests

**File:** `chat_shell/tests/test_load_skill_mcp.py`

```python
import pytest
from chat_shell.tools.builtin import LoadSkillTool

@pytest.mark.asyncio
async def test_load_skill_with_mcp_servers():
    """Test loading skill that declares MCP servers"""

    # Mock MCP loader callback
    loaded_servers = []
    async def mock_mcp_loader(skill_name, mcp_servers, task_data):
        loaded_servers.append((skill_name, list(mcp_servers.keys())))
        return []

    tool = LoadSkillTool(
        user_id=1,
        skill_names=["weibo"],
        skill_metadata={
            "weibo": {
                "description": "Weibo skill",
                "prompt": "Use Weibo tools",
                "mcpServers": ["weiboServer"],
            }
        },
        mcp_loader_callback=mock_mcp_loader,
        ghost_mcp_servers={
            "weiboServer": {"url": "https://api.example.com"},
            "otherServer": {"url": "https://other.com"},
        },
        task_data={"user": {"weibo_token": "test_token"}},
    )

    result = tool._run("weibo")

    assert "loaded" in result.lower()
    # MCP loader should be called with only weiboServer
    assert len(loaded_servers) == 1
    assert loaded_servers[0] == ("weibo", ["weiboServer"])
```

## Rollout Plan

1. **Phase 1:** Implement schema changes and skill_configs inclusion
2. **Phase 2:** Implement LoadSkillTool MCP loading logic
3. **Phase 3:** Integrate with ChatContext
4. **Phase 4:** Testing and bug fixes
5. **Phase 5:** Documentation updates
6. **Phase 6:** Deploy and monitor

## Known Limitations

1. **Async callback in sync tool:** LoadSkillTool._run() is sync but MCP loading is async. We use `loop.create_task()` which means tools won't be available immediately. Consider refactoring to async.

2. **Tool registration timing:** Tools are registered after skill prompt injection, so there might be a race condition. Need to ensure proper ordering.

3. **Error handling:** If MCP connection fails, skill still loads but without tools. Need clear error messages to LLM.

## Alternative Approach (Simpler)

Instead of dynamic loading during load_skill(), **preload all MCP servers** that are declared by ANY skill in Ghost.spec.skills:

1. When preparing ChatContext, scan all skill_configs for mcpServers
2. Merge with Ghost.mcpServers
3. Connect to all MCP servers upfront
4. Tools are available from the start

**Pros:**
- Simpler implementation
- No async callback needed
- Tools available immediately

**Cons:**
- Loads MCP servers even if skill not used
- Higher initial latency

## Recommended: Use Alternative Approach

Given the complexity of async callbacks in LoadSkillTool, I recommend the simpler preload approach for the first version.

---

**Status:** Ready for implementation
**Estimated Time:** 4-6 hours
**Priority:** P0 (blocking Weibo skill functionality)
