# 🎯 Skill System Architecture

This document provides a comprehensive guide to the Skill system in Wegent, covering architecture, implementation details, and development guidelines.

---

## Overview

**Skill** is a CRD (Custom Resource Definition) that provides on-demand capabilities and tools to AI Agents. Instead of loading all instructions into the system prompt, Skills are loaded dynamically when the LLM determines they are needed.

### Why Skills?

- **Token Efficiency**: Only load detailed instructions when needed, reducing context window usage
- **Modularity**: Package related prompts and tools together as reusable units
- **Extensibility**: Add new capabilities without modifying core agents

---

## Skill Relationship with Other CRDs

```
Ghost.spec.skills[] → references Skill names
     ↓
Bot (ghostRef) → inherits skills from Ghost
     ↓
Team (members[]) → Bot skills available in tasks
     ↓
Task execution → LLM calls load_skill() on demand
```

**Key Points:**
- Skills are referenced by name in `Ghost.spec.skills[]`
- A Ghost can have multiple skills
- Skills can be user-private (user_id > 0) or public (user_id = 0)
- Lookup priority: user-private Skills first, then public Skills

---

## Skill Package Structure

Skills are uploaded as ZIP packages containing:

```
skill-package.zip
├── SKILL.md          # Required: Metadata + prompt content
├── provider.py       # Optional: Tool provider implementation
└── *.py              # Optional: Additional tool modules
```

### SKILL.md Format

The SKILL.md file uses YAML frontmatter for metadata and markdown body for the prompt content:

```markdown
---
description: "Brief description - used by LLM to decide when to load"
displayName: "Human-readable name"
version: "1.0.0"
author: "Author Name"
tags: ["tag1", "tag2"]
bindShells: ["Chat", "ClaudeCode"]  # Compatible shell types
provider:
  module: provider                   # Python module name (without .py)
  class: MyToolProvider              # Provider class name
tools:
  - name: tool_name
    provider: provider_name
    config:
      timeout: 30
dependencies:
  - app.chat_shell.tools.pending_requests
---

# Skill Prompt Content

Detailed instructions that will be injected into system prompt
when the skill is loaded by the LLM...
```

### Metadata Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Brief description for LLM to decide when to load |
| `displayName` | No | Human-readable name for UI display |
| `version` | No | Semantic version number |
| `author` | No | Author name |
| `tags` | No | Tags for categorization |
| `bindShells` | No | Compatible Shell types (e.g., "Chat", "ClaudeCode") |
| `provider` | No | Provider configuration for dynamic tools |
| `tools` | No | Tool declarations |
| `dependencies` | No | Python module dependencies |

---

## Skill Loading Flow

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

1. **ChatConfigBuilder** (`backend/app/chat_shell/config/chat_config.py`)
   - Extracts skill metadata from Ghost configuration
   - Builds skill_names and skill_configs for the session

2. **System Prompt Injection** (`backend/app/chat_shell/utils/prompts.py`)
   - `append_skill_metadata_prompt()` injects skill summaries
   - Format: `- **{skill_name}**: {description}`

3. **LoadSkillTool** (`backend/app/chat_shell/tools/builtin/load_skill.py`)
   - Built-in tool called by LLM
   - Session-level caching prevents duplicate loading
   - Dynamic Provider loading for public skills only

---

## Skill Provider System

Providers allow Skills to define custom tools that are dynamically loaded at runtime.

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
from app.chat_shell.skills.provider import SkillToolProvider
from app.chat_shell.skills.context import SkillToolContext

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

### SkillToolRegistry

The `SkillToolRegistry` (`backend/app/services/chat_v2/skills/registry.py`) manages:
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

---

## Key Source Files

### Backend

| File | Purpose |
|------|---------|
| `app/schemas/kind.py` | Skill CRD schema definition (SkillSpec, SkillToolDeclaration, etc.) |
| `app/models/skill_binary.py` | SkillBinary SQLAlchemy model |
| `app/api/endpoints/kind/skills.py` | REST API routes |
| `app/services/skill_service.py` | SkillValidator for ZIP validation |
| `app/services/adapters/skill_kinds.py` | CRUD operations |
| `app/services/adapters/public_skill.py` | Public Skill management |
| `app/services/chat_v2/tools/builtin/load_skill.py` | LoadSkillTool implementation |
| `app/services/chat_v2/skills/registry.py` | SkillToolRegistry singleton |
| `app/services/chat_v2/skills/provider.py` | SkillToolProvider base class |
| `app/services/chat_v2/skills/context.py` | SkillToolContext for tool creation |
| `app/services/chat_v2/config/chat_config.py` | ChatConfigBuilder skill extraction |
| `app/services/chat_v2/utils/prompts.py` | Prompt injection utilities |

### Frontend

| File | Purpose |
|------|---------|
| `src/apis/skills.ts` | API client functions |
| `src/features/settings/components/SkillListWithScope.tsx` | Skill list with scope selector |
| `src/features/settings/components/skills/SkillManagementModal.tsx` | Skill management dialog |
| `src/features/settings/components/skills/SkillUploadModal.tsx` | Skill upload dialog |

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
│  - User creates Task with Team                                   │
│  - ChatConfigBuilder extracts skills                             │
│  - Skill metadata injected into system prompt                    │
│  - LLM calls load_skill() on demand                              │
│  - Provider loaded and tools registered                          │
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

## Best Practices

### Creating Skills

1. **Write clear descriptions** - The description is used by LLM to decide when to load
2. **Keep prompts focused** - Each skill should have a single, well-defined purpose
3. **Use appropriate bindShells** - Specify which Shell types are compatible
4. **Version your skills** - Use semantic versioning for tracking changes

### Provider Development

1. **Follow the interface** - Implement all abstract methods
2. **Handle errors gracefully** - Return meaningful error messages
3. **Use context properly** - Access task_id, subtask_id, ws_emitter from context
4. **Configure timeouts** - Set reasonable timeouts in tool_config

---

## Related Documentation

- [Core Concepts](./core-concepts.md) - Overview of all CRD types
- [YAML Specification](../reference/yaml-specification.md) - Complete YAML format reference
- [Architecture](./architecture.md) - System architecture overview

---

<p align="center">For more information, see the <a href="../../../AGENTS.md">AGENTS.md</a> development guide.</p>
