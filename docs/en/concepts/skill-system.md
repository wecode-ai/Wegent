---
sidebar_position: 3
---

# Skill System

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
- Skills can be user-private  or public
- Lookup priority: user-private Skills first, then public Skills

---

## Skill Package Structure

Skills are uploaded as ZIP packages containing:

```
skill-package.zip
├── SKILL.md          # Required: Metadata + prompt content
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

---

## Skill Workflow

1. **Create Skill**: User uploads a ZIP package containing SKILL.md
2. **Configure Association**: Add skill name to Ghost.spec.skills[]
3. **Runtime Loading**:
   - When task starts, skill metadata (name and description) is injected into system prompt
   - LLM decides whether to load a skill based on user request
   - Calls `load_skill()` tool to load the full skill prompt
4. **Update/Delete**: Upload new version or delete (must remove Ghost references first)

---

## Best Practices

### Creating Skills

1. **Write clear descriptions** - The description is used by LLM to decide when to load, should be concise and clear
2. **Keep prompts focused** - Each skill should have a single, well-defined purpose
3. **Use appropriate bindShells** - Specify which Shell types are compatible
4. **Version your skills** - Use semantic versioning for tracking changes

---

## Related Documentation

- [Core Concepts](./core-concepts.md) - Overview of all CRD types
- [YAML Specification](../reference/yaml-specification.md) - Complete YAML format reference
- [Skill Development Guide](../developer-guide/skill-development.md) - Technical implementation details and Provider development

---

<p align="center">For more information, see the <a href="../../../AGENTS.md">AGENTS.md</a> development guide.</p>
