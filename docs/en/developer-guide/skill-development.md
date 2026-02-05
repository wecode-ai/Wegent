---
sidebar_position: 8
---

# Skill Development Guide

This document provides technical implementation details for the Skill system, including architecture, Provider development, and API reference.

> **Basic Concepts**: Please read [Skill System Concepts](../concepts/skill-system.md) first to understand the basic concepts.

---

## Skill Implementation by Shell Type

The Skill system has different implementations for different Shell types:

| Shell Type | Skill Loading Method | Characteristics |
|-----------|---------------------|-----------------|
| **Chat** | Dynamic loading (load_skill tool) | LLM calls on-demand, prompt injection |
| **ClaudeCode** | Pre-deployed to filesystem | Downloaded to ~/.claude/skills/ at task startup |

---

## Chat Shell Skill Flow

### Loading Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Task Start - ChatConfigBuilder builds configuration          │
│    → Extract skill metadata from Ghost.spec.skills              │
│    → Inject skill summaries into system prompt                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. System Prompt Contains:                                      │
│    "## Available Skills                                         │
│    - **skill_name**: description (call load_skill to use)"      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. LLM Decides to Load Skill                                    │
│    → Calls load_skill(skill_name="xxx") tool                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. LoadSkillTool Executes                                       │
│    a. Find Skill (user private first, then public)              │
│    b. Extract full prompt from SKILL.md                         │
│    c. Load Provider dynamically (public skills only)            │
│    d. Register tools with SkillToolRegistry                     │
│    e. Cache loaded skill for session                            │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Details

1. **ChatConfigBuilder** (`chat_shell/chat_shell/services/chat_service.py`)
   - Extracts skill metadata from Ghost configuration
   - Builds skill_names and skill_configs for the session

2. **System Prompt Injection**
   - `append_skill_metadata_prompt()` injects skill summaries
   - Format: `- **{skill_name}**: {description}`

3. **LoadSkillTool**
   - Built-in tool called by LLM
   - Session-level caching prevents duplicate loading
   - Dynamic Provider loading for public skills only

---

## Claude Code Skill Flow

### Loading Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Task Start - ClaudeCodeAgent Initialization                  │
│    → Get skills list from bot_config                            │
│    → Call _download_and_deploy_skills()                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. SkillDownloader Downloads Skills                             │
│    a. Call Backend API to query skill info                      │
│       GET /api/v1/kinds/skills?name={skill_name}                │
│    b. Download skill ZIP package                                │
│       GET /api/v1/kinds/skills/{skill_id}/download              │
│    c. Extract to skills directory                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Skills Deployment Complete                                   │
│    - Docker mode: ~/.claude/skills/                             │
│    - Local mode: {task_config_dir}/skills/                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Claude Code SDK Uses Skills                                  │
│    - SDK automatically reads SKILL.md from skills directory     │
│    - User-selected skills get emphasis prompt added             │
└─────────────────────────────────────────────────────────────────┘
```

### Mode Differences

| Feature | Docker Mode | Local Mode |
|---------|------------|-----------|
| Skills Directory | `~/.claude/skills/` | `{task_config_dir}/skills/` |
| Cache Strategy | Clear and redeploy each time | Preserve existing, only download new |
| `clear_cache` | `true` | `false` |
| `skip_existing` | `false` | `true` |

### Key Components

1. **SkillDownloader** (`executor/services/api_client.py`)
   - Downloads skill ZIP packages from Backend API
   - Extracts to specified directory
   - Supports cache strategy configuration

2. **ModeStrategy** (`executor/agents/claude_code/mode_strategy.py`)
   - Defines `get_skills_directory()` to get skills directory
   - Defines `get_skills_deployment_options()` to get deployment options

3. **User-Selected Skills Emphasis** (`executor/agents/claude_code/claude_code_agent.py`)
   - `_build_skill_emphasis_prompt()` generates emphasis prompt for user-selected skills
   - Prompt prefix encourages model to prioritize using these skills

---

## Skill Provider System

Providers allow Skills to define custom tools that are dynamically loaded at runtime (Chat Shell only).

### Provider Interface

```python
from abc import ABC, abstractmethod
from typing import Any, Optional
from langchain_core.tools import BaseTool

class SkillToolProvider(ABC):
    """Base class for Skill tool providers."""

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Unique identifier for the provider."""
        pass

    @property
    @abstractmethod
    def supported_tools(self) -> list[str]:
        """List of tool names this provider supports."""
        pass

    @abstractmethod
    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a tool instance."""
        pass
```

### Example Provider Implementation

```python
from chat_shell.chat_shell.skills.provider import SkillToolProvider
from chat_shell.chat_shell.skills.context import SkillToolContext

class MermaidToolProvider(SkillToolProvider):
    @property
    def provider_name(self) -> str:
        return "mermaid"

    @property
    def supported_tools(self) -> list[str]:
        return ["render_mermaid"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        config = tool_config or {}
        from .render_mermaid import RenderMermaidTool
        return RenderMermaidTool(
            task_id=context.task_id,
            subtask_id=context.subtask_id,
            ws_emitter=context.ws_emitter,
            render_timeout=config.get("timeout", 30.0),
        )
```

### Provider Configuration in SKILL.md

```markdown
---
description: "Diagram visualization"
provider:
  module: provider                   # Python module name (without .py)
  class: MyToolProvider              # Provider class name
tools:
  - name: tool_name
    provider: provider_name
    config:
      timeout: 30
dependencies:
  - chat_shell.chat_shell.tools.pending_requests
---
```

### SkillToolRegistry

The `SkillToolRegistry` (`chat_shell/chat_shell/skills/registry.py`) manages:
- Provider registration and lookup (singleton, thread-safe)
- Dynamic Provider loading from ZIP packages
- Tool instance creation for skills

### Security Considerations

⚠️ **Important:** Only public Skills (user_id=0) can load dynamic code from providers. User-uploaded Skills can only provide prompt content. This prevents malicious code execution from user uploads.

---

## Database Storage

### Tables

| Table | Purpose |
|-------|---------|
| `kinds` | Skill CRD metadata (like other CRDs) |
| `skill_binaries` | ZIP package binary storage |

### skill_binaries Schema

```sql
CREATE TABLE skill_binaries (
    id INT PRIMARY KEY AUTO_INCREMENT,
    kind_id INT NOT NULL,              -- References kinds.id
    binary_data LONGBLOB NOT NULL,     -- ZIP package content
    file_size INT NOT NULL,            -- File size in bytes
    file_hash VARCHAR(64) NOT NULL,    -- SHA256 hash
    created_at DATETIME,
    FOREIGN KEY (kind_id) REFERENCES kinds(id) ON DELETE CASCADE
);
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/skills/upload` | POST | Upload Skill ZIP package |
| `/skills` | GET | List current user's Skills |
| `/skills/unified` | GET | List user + public Skills |
| `/skills/public/list` | GET | List public Skills |
| `/skills/public` | POST | Create public Skill (admin only) |
| `/skills/invoke` | POST | Get Skill prompt content |
| `/skills/{skill_id}` | GET | Get Skill details |
| `/skills/{skill_id}/download` | GET | Download Skill ZIP package |
| `/skills/{skill_id}` | PUT | Update Skill |
| `/skills/{skill_id}` | DELETE | Delete Skill (checks references) |
| `/api/tasks/{task_id}/skills` | GET | Get task-associated Skills (used by Claude Code) |

---

## Key Source Files

### Chat Shell

| File | Purpose |
|------|---------|
| `chat_shell/chat_shell/skills/registry.py` | SkillToolRegistry singleton |
| `chat_shell/chat_shell/skills/provider.py` | SkillToolProvider base class |
| `chat_shell/chat_shell/skills/context.py` | SkillToolContext for tool creation |
| `chat_shell/chat_shell/tools/skill_factory.py` | Skill tool factory |

### Executor (Claude Code)

| File | Purpose |
|------|---------|
| `executor/services/api_client.py` | SkillDownloader and fetch_task_skills |
| `executor/agents/claude_code/claude_code_agent.py` | _download_and_deploy_skills implementation |
| `executor/agents/claude_code/mode_strategy.py` | ModeStrategy base class |
| `executor/agents/claude_code/docker_mode_strategy.py` | Docker mode strategy |
| `executor/agents/claude_code/local_mode_strategy.py` | Local mode strategy |

### Backend

| File | Purpose |
|------|---------|
| `backend/app/schemas/kind.py` | Skill CRD schema definition |
| `backend/app/models/skill_binary.py` | SkillBinary SQLAlchemy model |
| `backend/app/api/endpoints/kind/skills.py` | REST API routes |
| `backend/app/services/skill_service.py` | SkillValidator for ZIP validation |

### Frontend

| File | Purpose |
|------|---------|
| `frontend/src/apis/skills.ts` | API client functions |
| `frontend/src/features/settings/components/SkillListWithScope.tsx` | Skill list with scope selector |
| `frontend/src/features/settings/components/skills/SkillManagementModal.tsx` | Skill management dialog |
| `frontend/src/features/settings/components/skills/SkillUploadModal.tsx` | Skill upload dialog |

---

## Built-in Skills

Located in `backend/init_data/skills/`:

| Skill | Description |
|-------|-------------|
| `mermaid-diagram` | Diagram visualization using Mermaid.js |
| `wiki_submit` | Wiki submission capability |

---

## Skill Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     1. Create Skill                              │
│  - User uploads ZIP package                                      │
│  - Validate SKILL.md format and extract metadata                 │
│  - Store in kinds table and skill_binaries table                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     2. Configure Association                     │
│  - Add skill name to Ghost.spec.skills[]                        │
│  - Ghost is referenced by Bot                                    │
│  - Bot is referenced by Team                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     3. Runtime Loading                           │
│  Chat Shell:                                                     │
│  - Skill metadata injected into system prompt                    │
│  - LLM calls load_skill() on demand                              │
│  - Provider loaded and tools registered                          │
│                                                                  │
│  Claude Code:                                                    │
│  - Download skill ZIP packages at task startup                   │
│  - Extract to skills directory                                   │
│  - Claude Code SDK automatically reads and uses                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     4. Update/Delete                             │
│  - Update: Upload new ZIP, metadata updated                      │
│  - Delete: Check Ghost references first, reject if referenced    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Provider Development Best Practices

1. **Follow the interface** - Implement all abstract methods
2. **Handle errors gracefully** - Return meaningful error messages
3. **Use context properly** - Access task_id, subtask_id, ws_emitter from context
4. **Configure timeouts** - Set reasonable timeouts in tool_config

---

## Related Documentation

- [Skill System Concepts](../concepts/skill-system.md) - Basic concepts and usage
- [Core Concepts](../concepts/core-concepts.md) - Overview of all CRD types
- [YAML Specification](../reference/yaml-specification.md) - Complete YAML format reference
