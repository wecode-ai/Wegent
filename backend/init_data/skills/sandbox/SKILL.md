---
description: "Provides sub_claude_agent for running Claude AI tasks, and upload_attachment/download_attachment for file transfers. The read_file/write_file/exec/list_files tools are now builtin and automatically available without loading this skill."
displayName: "沙箱环境"
version: "3.0.0"
author: "Wegent Team"
tags: ["sandbox", "code-execution", "claude-ai", "attachment"]
bindShells: ["Chat"]
provider:
  module: provider
  class: SandboxToolProvider
config:
  default_shell_type: "ClaudeCode"
  timeout: 7200
  command_timeout: 300
  max_file_size: 1048576
  bot_config:
    - shell_type: "ClaudeCode"
      agent_config:
        env:
          model: "claude"
          api_key: "xxxxx"
          base_url: "xxxxx"
          model_id: "xxxxx"
          small_model: "xxxxx"
tools:
  - name: sub_claude_agent
    provider: sandbox
    config:
      command_timeout: 1800
  - name: upload_attachment
    provider: sandbox
    config:
      max_file_size: 104857600
  - name: download_attachment
    provider: sandbox
---

# Sandbox Environment

Execute complex Claude AI tasks and manage file attachments in isolated Docker containers running **AlmaLinux 9.4**.

## Important: Builtin Filesystem Tools

> **Note**: The following tools are now **builtin** in Chat Shell and are automatically available without loading this skill:
> - `read_file` - Read file contents
> - `write_file` - Write content to files
> - `list_files` - List directory contents
> - `exec` - Execute shell commands
>
> These builtin tools support both **local mode** (direct filesystem access) and **remote mode** (E2B sandbox).
> You only need to load this skill if you need `sub_claude_agent` or attachment operations.

## Core Capabilities

The sandbox skill now focuses on:

1. **Claude AI Tasks** - Run Claude AI agent for complex multi-step programming tasks
2. **Attachment Upload** - Upload generated files to Wegent for user download
3. **Attachment Download** - Download user attachments for processing in sandbox

## When to Use This Skill

Use this skill when you need to:

- ✅ Run Claude AI for complex programming tasks (`sub_claude_agent`)
- ✅ Upload generated files for user download (`upload_attachment`)
- ✅ Download user attachments for processing (`download_attachment`)

**Note**: For basic file operations (read/write/list/exec), use the builtin tools directly - no need to load this skill.

## Available Tools

### `sub_claude_agent`

Run Claude AI to execute complex tasks in the sandbox.

**⚠️ IMPORTANT**: This tool should **only be used when the user explicitly requests it**. Do not use this tool automatically or as a default option.

**Use Cases:**
- When user explicitly asks to use Claude (e.g., "use Claude to generate...", "ask Claude to create...")
- Generate presentations and Word documents (when specifically requested)
- Create code projects (when specifically requested)
- Complex multi-step programming tasks (when specifically requested)

**Parameters:**
- `prompt` (required): Task description for Claude
- `allowed_tools` (optional): List of tools Claude can use
- `append_system_prompt` (optional): Additional system prompt
- `timeout` (optional): Timeout in seconds (minimum: 600 seconds / 10 minutes, default: 1800 seconds / 30 minutes)

**Features:**
- ⚡ Real-time streaming output
- 🔧 Customizable tool sets
- 📊 WebSocket progress updates

**Example:**
```json
{
  "name": "sub_claude_agent",
  "arguments": {
    "prompt": "Create a 5-page presentation about the history of artificial intelligence",
    "allowed_tools": "Edit,Write,Bash(*),skills,Read"
  }
}
```

---

### `upload_attachment`

Upload a file from sandbox to Wegent and get a download URL for users.

**Use Cases:**
- Upload generated documents (PDF, Word, etc.) for user download
- Share files created in the sandbox with users
- Export results from sandbox to Wegent storage
- User can not access file directly, you MUST use upload_attachment tool for sending file to user.

**Parameters:**
- `file_path` (required): Path to the file in sandbox to upload
- `timeout_seconds` (optional): Upload timeout in seconds (default: 300)

**Returns:**
- `success`: Whether the upload succeeded
- `attachment_id`: ID of the uploaded attachment
- `filename`: Name of the uploaded file
- `file_size`: Size of the file in bytes
- `mime_type`: MIME type of the file
- `download_url`: Relative URL for downloading (e.g., `/api/attachments/123/download`)

**Limits:**
- Maximum file size: 100MB

**Example:**
```json
{
  "name": "upload_attachment",
  "arguments": {
    "file_path": "/home/user/documents/report.pdf"
  }
}
```

**After Upload - Presenting to User:**
After a successful upload, present the download link to the user:
```
Document generation completed!

📄 **report.pdf**

[Click to Download](/api/attachments/123/download)
```

---

### `download_attachment`

Download a file from Wegent attachment URL to sandbox for processing.

**Use Cases:**
- Download user-uploaded attachments for processing
- Retrieve files from Wegent storage into the sandbox

**Parameters:**
- `attachment_url` (required): Wegent attachment URL (e.g., `/api/attachments/123/download`)
- `save_path` (required): Path to save the file in sandbox
- `timeout_seconds` (optional): Download timeout in seconds (default: 300)

**Returns:**
- `success`: Whether the download succeeded
- `file_path`: Full path to the downloaded file in sandbox
- `file_size`: Size of the downloaded file in bytes

**Example:**
```json
{
  "name": "download_attachment",
  "arguments": {
    "attachment_url": "/api/attachments/123/download",
    "save_path": "/home/user/downloads/document.pdf"
  }
}
```

---

## Tool Selection Guide

| Task Type | Recommended Tool | Reason |
|-----------|-----------------|--------|
| Execute commands or scripts | `exec` (builtin) | Fast execution, no skill loading needed |
| Read files | `read_file` (builtin) | Better error handling and size validation |
| Write files | `write_file` (builtin) | Auto directory creation, size validation |
| Browse directories | `list_files` (builtin) | Structured output with metadata |
| Upload files for user download | `upload_attachment` | Get download URL for user-facing files |
| Download attachments | `download_attachment` | Retrieve Wegent attachments into sandbox |
| Complex tasks with Claude | `sub_claude_agent` | **Only when user explicitly requests** |

**Important**: For basic filesystem operations, use the builtin tools directly. Only load this skill when you need Claude AI tasks or attachment operations.

---

## Sandbox Environment

### System Environment
- **Operating System**: AlmaLinux 9.4 (RHEL 9 compatible)
- **Architecture**: x86_64
- **Package Manager**: dnf/yum
- **Init System**: systemd
- **Python**: 3.12+ (pre-installed)
- **Shell**: bash

### Lifecycle
- New sandbox created on first tool call
- Subsequent calls in the same session reuse the sandbox
- Sandbox persists for 30 minutes by default
- Files persist within the session
- Each sandbox runs in an isolated Docker container

### Resource Limits
- **Upload file limit**: 100MB (configurable)
- **Claude timeout**: 1800 seconds (30 minutes, minimum: 600 seconds / 10 minutes)
- **Total task timeout**: 7200 seconds (2 hours)

### Security Features
- ✅ Fully isolated Docker containers (AlmaLinux 9.4)
- ✅ Network access control
- ✅ Resource constraints
- ✅ Automatic cleanup

---

## Configuration Options

### Shell Types
- **ClaudeCode** (default): For code generation, Git operations, multi-step programming
- **Agno**: For team collaboration and multi-agent coordination

### Claude Tool Configuration
Control Claude's available tools via the `allowed_tools` parameter:

```json
{
  "allowed_tools": "Edit,Write,MultiEdit,Bash(*),skills,Read,Glob,Grep,LS"
}
```

- `Bash(*)`: Allow all Bash commands
- Restrict tools as needed for enhanced security or task focus

---

## Best Practices

1. **Use Builtin Tools First** - For read/write/exec/list, use builtin tools (no skill loading)
2. **Load This Skill Only When Needed** - For Claude AI or attachment operations
3. **Clear Task Descriptions** - Provide detailed instructions and expected outcomes
4. **Use Absolute Paths** - Avoid path ambiguity
5. **Check Return Results** - Verify the `success` field
6. **Only Use sub_claude_agent When Requested** - Don't use it automatically

---

## Troubleshooting

### Sandbox Creation Failed
**Cause**: Executor Manager unavailable
**Solution**: Check service status and configuration

### File Not Found
**Cause**: Incorrect path or file doesn't exist
**Solution**: Use absolute paths, verify with `list_files` first

### Command Timeout
**Cause**: Task execution takes too long
**Solution**: Increase timeout setting or split into smaller tasks

### Permission Denied
**Cause**: Insufficient file permissions
**Solution**: Check file paths and permission settings
