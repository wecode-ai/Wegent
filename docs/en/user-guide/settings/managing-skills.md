---
sidebar_position: 4
---

# ✨ Managing Skills

Skills are Claude Code capability extension packages that add specialized functionality to your Bots. This guide will teach you how to upload, manage, and use Skills in Wegent.

---

## 📋 Table of Contents

- [What is a Skill](#-what-is-a-skill)
- [Creating a Skill Package](#-creating-a-skill-package)
- [Uploading Skills](#-uploading-skills)
- [Managing Skills](#-managing-skills)
- [Using Skills in Bots](#-using-skills-in-bots)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Skill

A **Skill** is a Claude Code capability extension package that contains executable code, configurations, and documentation. Skills are deployed to `~/.claude/skills/` when a task starts, extending the agent's capabilities.

**Analogy**: If a Bot is like a person, Skills are like tools or special training:
- **Ghost**: Person's personality and base knowledge
- **Skills**: Specialized tools and techniques the person can use
- **Bot**: Complete person with tools

**Examples of Skills**:
- Python debugging tools
- Code formatters and linters
- API testing utilities
- Database query helpers
- Custom workflow automation

---

## 📦 Creating a Skill Package

### Requirements

A Skill must be packaged as a ZIP file containing:

1. **SKILL.md** (required): Documentation with YAML frontmatter
2. **Other files**: Scripts, configurations, assets, etc.

### SKILL.md Format

```markdown
---
description: "Brief description of what this skill does"
version: "1.0.0"
author: "Your Name"
tags: ["category1", "category2"]
---

# Skill Name

## Overview

Detailed description of the skill's functionality.

## Usage

How to use this skill...

## Examples

Example code or commands...
```

### YAML Frontmatter Fields

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `description` | Yes | Brief skill description | "Python debugging tool with breakpoint support" |
| `version` | No | Semantic version number | "1.0.0", "2.3.1" |
| `author` | No | Author name or organization | "WeCode Team", "Your Name" |
| `tags` | No | Category tags (array) | ["python", "debugging", "development"] |

### Directory Structure Example

```
my-skill.zip
├── SKILL.md                 # Required: Documentation with frontmatter
├── main.py                  # Your skill code
├── config.json              # Configuration file (optional)
├── utils/
│   ├── helper.py
│   └── formatter.py
└── README.md                # Additional docs (optional)
```

### Creating the ZIP Package

**Using command line:**
```bash
cd my-skill-directory
zip -r my-skill.zip .
```

**Important**:
- Include SKILL.md at the root level or in a subdirectory
- Keep file size under 10MB
- Avoid including sensitive data (API keys, passwords)
- Use relative paths in your code

---

## ⬆️ Uploading Skills

### Via Web UI

1. **Navigate to Skills Page**
   - Go to Settings (⚙️)
   - Click on "Skills" tab

2. **Upload Skill**
   - Click "Upload Skill" button
   - Enter a unique skill name (e.g., `python-debugger`)
   - Select or drag-and-drop your ZIP file
   - Wait for upload to complete

3. **Verify Upload**
   - Skill card appears in the list
   - Check metadata (version, author, tags)
   - Status shows "Available"

### Upload Requirements

- **File format**: Must be a `.zip` file
- **File size**: Maximum 10MB
- **Name**: Unique identifier (lowercase, hyphens allowed)
- **SKILL.md**: Must be present and valid

### Validation

The system validates:
- ✅ ZIP file format
- ✅ File size < 10MB
- ✅ SKILL.md exists
- ✅ YAML frontmatter is valid
- ✅ `description` field is present
- ✅ No security issues (Zip Slip attacks)

---

## 🛠️ Managing Skills

### Viewing Skills

**Skills List displays:**
- Skill name
- Description (first 2 lines)
- Version, author, tags
- File size and status
- Last updated time

### Downloading Skills

1. Find your skill in the list
2. Click the download icon (⬇️)
3. ZIP file is downloaded to your computer

**Use case**: Backup, share with team, or modify locally

### Updating Skills

1. Click the edit icon (✏️) on a skill card
2. Upload a new ZIP file
3. Name and namespace cannot be changed
4. Metadata is extracted from the new SKILL.md

**Note**: All Bots using this skill will get the updated version on next task start.

### Deleting Skills

1. Click the delete icon (🗑️) on a skill card
2. Confirm deletion in the dialog

**Important**:
- ⚠️ Cannot delete skills referenced by Bots/Ghosts
- Remove skill from all Bots first
- Error message shows which Bots are using the skill

---

## 🤖 Using Skills in Bots

### Associating Skills with Bots

1. **Edit Bot**
   - Go to Settings > Bots
   - Click edit on a Bot

2. **Add Skills**
   - Find the "Skills" section (below Agent Config)
   - Click the dropdown to see available skills
   - Select skills to add
   - Skills appear as removable tags

3. **Save Bot**
   - Click "Save" button
   - Skills are now associated with the Bot

### Via YAML Configuration

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
  namespace: default
spec:
  systemPrompt: "You are a senior developer..."
  mcpServers:
    github:
      command: docker
      args: [...]
  skills:
    - python-debugger      # Skill name
    - code-formatter
    - api-tester
```

### How Skills Are Deployed

When a task starts:

1. **Executor fetches Bot configuration** including skills list
2. **Downloads each skill** from the API
3. **Extracts ZIP files** to `~/.claude/skills/{skill-name}/`
4. **Claude Code loads skills** automatically
5. **Agent can use skill capabilities** during task execution

**Deployment path example**:
```
~/.claude/skills/
├── python-debugger/
│   ├── SKILL.md
│   ├── main.py
│   └── utils/
├── code-formatter/
│   ├── SKILL.md
│   └── formatter.py
└── api-tester/
    ├── SKILL.md
    └── test_runner.py
```

---

## 💡 Best Practices

### Creating Skills

1. **Clear Documentation**
   - Write comprehensive SKILL.md
   - Include usage examples
   - Document dependencies

2. **Semantic Versioning**
   - Use version numbers: `MAJOR.MINOR.PATCH`
   - Increment major for breaking changes
   - Increment minor for new features
   - Increment patch for bug fixes

3. **Meaningful Tags**
   - Use descriptive category tags
   - Examples: `["python", "testing"]`, `["nodejs", "linting"]`
   - Helps with discovery and organization

4. **Keep It Focused**
   - One skill = one specific capability
   - Don't create monolithic skills
   - Easier to maintain and reuse

### Managing Skills

1. **Naming Convention**
   - Use lowercase with hyphens: `my-skill-name`
   - Be descriptive: `python-unit-test-runner` vs `runner`
   - Include language/framework if relevant

2. **Version Control**
   - Update version number when modifying
   - Keep old versions for rollback (download before update)
   - Document changes in SKILL.md

3. **Security**
   - Never include API keys or passwords
   - Use environment variables for secrets
   - Review ZIP contents before uploading

4. **Size Optimization**
   - Remove unnecessary files
   - Compress assets when possible
   - Stay well under 10MB limit

### Using Skills

1. **Test Individually**
   - Create a Bot with one skill first
   - Verify it works correctly
   - Then combine multiple skills

2. **Document Dependencies**
   - Note which skills work together
   - Document any conflicts
   - Update Bot descriptions

3. **Monitor Usage**
   - Check which Bots use each skill
   - Remove unused skills
   - Keep skills up to date

---

## ❓ Common Issues

### Upload Failures

**Problem**: "SKILL.md not found in ZIP package"
- ✅ Ensure SKILL.md exists at root or in subdirectory
- ✅ Check file name is exactly `SKILL.md` (case-sensitive)

**Problem**: "Invalid YAML frontmatter"
- ✅ Verify YAML syntax between `---` markers
- ✅ Ensure `description` field is present
- ✅ Check for proper indentation

**Problem**: "File size exceeds 10MB"
- ✅ Remove unnecessary files
- ✅ Compress large assets
- ✅ Split into multiple smaller skills

### Deletion Issues

**Problem**: "Cannot delete Skill referenced by Ghosts"
- ✅ Check error message for Bot/Ghost names
- ✅ Edit those Bots to remove the skill
- ✅ Then delete the skill

### Deployment Issues

**Problem**: Skill not available in task
- ✅ Verify skill is associated with Bot
- ✅ Check task logs for download errors
- ✅ Ensure skill status is "Available"

**Problem**: "Unsafe file path detected in ZIP"
- ✅ Don't use `../` in file paths
- ✅ Don't use absolute paths like `/etc/`
- ✅ Use only relative paths within the ZIP

---

## 🔗 Related Resources

### Documentation
- [YAML Specification - Skill](../../../../../reference/yaml-specification.md#-skill)
- [Agent Settings](./agent-settings.md) - Configure agents and bots with skills

### External Resources
- [Claude Code Skills Documentation](https://docs.claude.com/en/docs/claude-code/skills)
- [Semantic Versioning](https://semver.org/)
- [YAML Syntax Guide](https://yaml.org/spec/1.2/spec.html)

### Examples
- Coming soon: Wegent Skills Repository
- Community-contributed skills
- Pre-built skill templates

---

## 🎓 Quick Start Example

### 1. Create a Simple Skill

Create a directory structure:
```
hello-skill/
├── SKILL.md
└── hello.py
```

**SKILL.md**:
```markdown
---
description: "A simple hello world skill"
version: "1.0.0"
author: "Your Name"
tags: ["example", "tutorial"]
---

# Hello Skill

A simple example skill that prints a greeting.

## Usage

This skill provides a hello() function that can be called by the agent.
```

**hello.py**:
```python
def hello(name="World"):
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(hello())
```

### 2. Package the Skill

```bash
cd hello-skill
zip -r hello-skill.zip .
```

### 3. Upload to Wegent

1. Go to Settings > Skills
2. Click "Upload Skill"
3. Name: `hello-skill`
4. Upload `hello-skill.zip`
5. Wait for success message

### 4. Use in a Bot

1. Go to Settings > Bots
2. Edit or create a Bot
3. Scroll to "Skills" section
4. Select `hello-skill`
5. Save Bot

### 5. Test in a Task

Create a task using this Bot and ask it to use the hello skill!

---

**Need Help?**
- Check [Common Issues](#-common-issues)
- Review [YAML Specification](../../reference/yaml-specification.md)
- Ask in Wegent community forums
