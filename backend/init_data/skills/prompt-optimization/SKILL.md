---
description: "Use this skill when the user wants to optimize, modify, or improve the system prompt of an AI agent. This includes requests like 'optimize the prompt', 'make the AI more focused on X', 'change the system prompt', 'improve the agent behavior', or 'modify how the AI responds'."
displayName: "提示词管理工具"
version: "2.0.0"
author: "Wegent Team"
tags: ["prompt", "optimization", "system-prompt", "agent-config", "ai-tuning"]
bindShells: ["Chat"]
mcpServers:
 wegent-prompt-optimization:
    type: streamable-http
    url: "${{backend_url}}/mcp/prompt-optimization/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Prompt Optimization Skill

This skill allows you to view and modify the system prompts of the current AI agent (Team).

## Available Tools

- `get_team_prompt()` — Get the current prompt and source mapping for the team
- `submit_prompt_changes(changes)` — Send optimized prompts to the user for review

## Workflow

### Step 1: Get Current Prompts

Call `get_team_prompt()`. It returns:
- `team_id`: The team's database ID
- `assembled_prompt`: The full assembled prompt
- `sources`: Array of prompt sources, each with:
  - `type`: `"ghost"` (base prompt) or `"member"` (team member prompt)
  - `id`: Resource ID (Ghost ID or Team ID)
  - `name`: Display name (Ghost name or Bot name)
  - `field`: Field name (e.g., `"systemPrompt"` or `"prompt"`)
  - `content`: The actual prompt text
  - `index`: Member index (only for `"member"` type)

### Step 2: Analyze and Rewrite

Based on the user's request, determine which source(s) need modification:
- If the user wants to change the agent's core behavior → modify the `ghost` source
- If the user wants to change a specific team member's role → modify the `member` source
- You may modify multiple sources if needed

**Rules:**
- Only modify the sources that are relevant to the user's request
- Preserve the overall structure and intent of unrelated parts
- Write complete, production-quality prompts (not just appending text)
- If the original prompt is in Chinese, write the modification in Chinese
- If the original prompt is in English, write the modification in English

### Step 3: Submit Changes

Call `submit_prompt_changes(changes=[...])` with your changes. Each change must include:

```json
{
  "type": "ghost",          // or "member"
  "id": 561,                // from source.id
  "name": "Ghost名称",      // from source.name, used for display
  "field": "systemPrompt",  // from source.field
  "original": "原始内容",    // from source.content
  "suggested": "修改后内容",  // your optimized version
  "index": 0                // only for "member" type, from source.index
}
```

This will display interactive cards to the user showing the original vs modified prompt.
The user can then apply or cancel each change independently.

## Example

User: "让这个AI更关注Python编程"

```
1. Call get_team_prompt()
   → sources: [{ type: "ghost", id: 561, name: "code-helper", field: "systemPrompt", content: "You are a code assistant." }]

2. Rewrite the prompt:
   "You are a code assistant specializing in Python programming. Focus on Python best practices, common patterns, and debugging Python code."

3. Call submit_prompt_changes(changes=[{
     type: "ghost",
     id: 561,
     name: "code-helper",
     field: "systemPrompt",
     original: "You are a code assistant.",
     suggested: "You are a code assistant specializing in Python programming. Focus on Python best practices, common patterns, and debugging Python code."
   }])
```

## Important Notes

- The user must have Developer+ permission on the target resources to apply changes
- Changes are NOT applied automatically — the user reviews and clicks "Apply" on each card
- After the user applies changes, the tool returns `__silent_exit__` to end silently
