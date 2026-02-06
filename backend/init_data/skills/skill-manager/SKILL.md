# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

---
description: "Export and publish Skills created in Claude Code sandbox. Provides scripts to download Skills as ZIP or publish directly to Wegent system."
displayName: "Skill Manager"
version: "1.0.0"
author: "Wegent Team"
tags: ["skill", "export", "publish", "management"]
bindShells: ["ClaudeCode"]
---

# Skill Manager

This skill provides tools to export and publish Skills created in the Claude Code sandbox.

## Available Scripts

All scripts are located in the `~/.claude/skills/skill-manager/` directory.

### 1. Export Skill (Download to Local)

Export a Skill directory as a ZIP file and upload it as an attachment for user download.

**Usage:**
```bash
bash ~/.claude/skills/skill-manager/export-skill.sh <skill_path> [output_name]
```

**Parameters:**
- `skill_path` (required): Path to the Skill directory (must contain SKILL.md)
- `output_name` (optional): Name for the exported ZIP file (without .zip extension). Defaults to directory name.

**Example:**
```bash
# Export a skill named "my-review-skill"
bash ~/.claude/skills/skill-manager/export-skill.sh /home/user/my-review-skill

# Export with custom name
bash ~/.claude/skills/skill-manager/export-skill.sh /home/user/my-skill code-reviewer
```

**Output:**
Returns a download link that the user can click to download the ZIP file.

---

### 2. Publish Skill (Upload to Wegent)

Publish a Skill directly to the user's Wegent Skill library.

**Usage:**
```bash
bash ~/.claude/skills/skill-manager/publish-skill.sh <skill_path> <skill_name> [namespace] [--overwrite]
```

**Parameters:**
- `skill_path` (required): Path to the Skill directory (must contain SKILL.md)
- `skill_name` (required): Name for the Skill in Wegent (used as unique identifier)
- `namespace` (optional): Namespace for the Skill. Defaults to "default" (personal).
- `--overwrite` (optional): If a Skill with the same name exists, overwrite it.

**Example:**
```bash
# Publish a skill to personal namespace
bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer

# Publish to a specific namespace (group)
bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer my-team

# Overwrite existing skill
bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer default --overwrite
```

**Output:**
Returns the Skill ID and confirmation message.

---

## Environment Variables

These environment variables are automatically available in the executor container:

- `TASK_INFO`: JSON object containing task context including `auth_token`
- `TASK_API_DOMAIN`: Backend API domain (e.g., `http://wegent-backend:8000`)

---

## Skill Directory Structure

A valid Skill directory must contain a `SKILL.md` file with YAML frontmatter:

```
my-skill/
├── SKILL.md          # Required: Skill metadata and prompt
├── script.js         # Optional: Helper scripts
└── other-files/      # Optional: Additional resources
```

**SKILL.md Format:**
```markdown
---
description: "Brief description of what this skill does"
displayName: "Human Readable Name"
version: "1.0.0"
author: "Your Name"
tags: ["tag1", "tag2"]
bindShells: ["ClaudeCode"]  # or ["Chat"] or both
---

# Skill Title

Your skill prompt and instructions here...
```

---

## Usage Scenarios

### Scenario 1: User wants to download a created Skill

```
User: "Export my-review-skill so I can download it"

AI Response:
I'll export the skill for you.

> bash ~/.claude/skills/skill-manager/export-skill.sh /home/user/my-review-skill

✅ Skill exported successfully!

📦 **my-review-skill.zip** (12.3 KB)

[Click to Download](/api/attachments/123/download)

You can save this file locally and:
- Share it with other users
- Upload it to another Wegent account via Settings > Skills
```

### Scenario 2: User wants to publish a Skill to Wegent

```
User: "Publish this skill to my Wegent account as 'code-reviewer'"

AI Response:
I'll publish the skill to your Wegent account.

> bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer

✅ Skill published successfully!

📦 **code-reviewer**
   - Skill ID: 456
   - Namespace: default (Personal)
   - Status: Created

You can now use this Skill when creating Agents in Wegent Settings.
```

---

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| "SKILL.md not found" | Directory doesn't contain SKILL.md | Create SKILL.md with valid frontmatter |
| "Skill already exists" | Same name exists in namespace | Use `--overwrite` flag or choose different name |
| "Invalid SKILL.md format" | Missing required frontmatter fields | Add `description` field to frontmatter |
| "Authentication failed" | Invalid or expired token | Ensure task is running in valid session |
