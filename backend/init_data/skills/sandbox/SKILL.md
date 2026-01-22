---
description: "Provides isolated sandbox execution environments (AlmaLinux 9.4) for safely executing commands, running code, and managing filesystems. Ideal for code testing, file management, and command execution. The sandbox_claude tool is available for advanced use cases but should only be used when explicitly requested by the user."
displayName: "沙箱环境"
version: "2.1.0"
author: "Wegent Team"
tags: ["sandbox", "code-execution", "filesystem", "automation"]
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
  - name: sandbox_command
    provider: sandbox
  - name: sandbox_claude
    provider: sandbox
    config:
      command_timeout: 1800
  - name: sandbox_list_files
    provider: sandbox
  - name: sandbox_read_file
    provider: sandbox
  - name: sandbox_write_file
    provider: sandbox
    config:
      max_file_size: 10485760
  - name: sandbox_upload_attachment
    provider: sandbox
    config:
      max_file_size: 104857600
  - name: sandbox_download_attachment
    provider: sandbox
---

# Sandbox Environment

Execute code, commands, and complex tasks securely in isolated Docker containers running **AlmaLinux 9.4**.

## Core Capabilities

The sandbox environment provides fully isolated execution spaces with:

1. **Command Execution** - Run shell commands, scripts, and programs
2. **File Operations** - Read/write files, browse directories, manage filesystems
3. **Code Execution** - Safely execute and test code
4. **Claude AI Tasks** - Available for advanced use cases when explicitly requested by users
5. **Attachment Upload/Download** - Upload generated files to Wegent for user download, or download user attachments for processing

## When to Use

Use this skill when you need to:

- ✅ Execute shell commands or scripts
- ✅ Run and test code
- ✅ Read, write, or manage files
- ✅ Perform multi-step programming tasks
- ✅ Git operations (clone, commit, push, etc.)
- ✅ Require isolated environment for safety

**Note**: The `sandbox_claude` tool should only be used when the user explicitly requests Claude AI assistance (e.g., "use Claude to generate...", "ask Claude to create...").

## Available Tools

### Command Execution

#### `sandbox_command`
Execute shell commands in the sandbox environment.

**Use Cases:**
- Run single commands or scripts
- Directory operations (create, delete, move)
- Install dependencies, run tests
- View system information

**Parameters:**
- `command` (required): Shell command to execute
- `working_dir` (optional): Working directory path
- `timeout` (optional): Timeout in seconds

**Example:**
```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "python script.py --arg value",
    "working_dir": "/home/user/project"
  }
}
```

---

#### `sandbox_claude`
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
  "name": "sandbox_claude",
  "arguments": {
    "prompt": "Create a 5-page presentation about the history of artificial intelligence",
    "allowed_tools": "Edit,Write,Bash(*),skills,Read"
  }
}
```

---

### File Operations

#### `sandbox_list_files`
List files and subdirectories in a directory.

**Parameters:**
- `path` (required): Directory path
- `depth` (optional): Recursion depth, default 1

**Returns:**
- File metadata including name, size, permissions, modification time

**Example:**
```json
{
  "name": "sandbox_list_files",
  "arguments": {
    "path": "/home/user/project",
    "depth": 2
  }
}
```

---

#### `sandbox_read_file`
Read file contents.

**Parameters:**
- `file_path` (required): File path to read

**Limits:**
- Maximum file size: 1MB (configurable)

**Example:**
```json
{
  "name": "sandbox_read_file",
  "arguments": {
    "file_path": "/home/user/config.json"
  }
}
```

---

#### `sandbox_write_file`
Write content to a file.

⚠️ **IMPORTANT**: Both `file_path` AND `content` are **REQUIRED** parameters. You must always provide the content to write.

**Parameters:**
- `file_path` (REQUIRED): File path to write
- `content` (REQUIRED): Content to write (MUST be provided, cannot be omitted)
- `format` (optional): Content format - 'text' (default) or 'bytes' (base64-encoded)
- `create_dirs` (optional): Auto-create parent directories (default: True)

**Features:**
- Automatically creates parent directories
- Maximum file size: 10MB (configurable)

**Example - Text file:**
```json
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/output.txt",
    "content": "Hello, Sandbox!"
  }
}
```

**Example - HTML file:**
```json
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/index.html",
    "content": "<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>"
  }
}
```

---

### Attachment Operations

#### `sandbox_upload_attachment`
Upload a file from sandbox to Wegent and get a download URL for users.

**Use Cases:**
- Upload generated documents (PDF, Word, etc.) for user download
- Share files created in the sandbox with users
- Export results from sandbox to Wegent storage

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
  "name": "sandbox_upload_attachment",
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

#### `sandbox_download_attachment`
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
  "name": "sandbox_download_attachment",
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
| Execute commands or scripts | `sandbox_command` | Fast execution, no overhead |
| Create/delete directories | `sandbox_command` | Use `mkdir -p` or `rm -rf` directly |
| Read files | `sandbox_read_file` | Better error handling and size validation |
| Write files | `sandbox_write_file` | Auto directory creation, size validation |
| Browse directories | `sandbox_list_files` | Structured output with metadata |
| Upload files for user download | `sandbox_upload_attachment` | Get download URL for user-facing files |
| Download attachments | `sandbox_download_attachment` | Retrieve Wegent attachments into sandbox |
| Complex tasks with Claude | `sandbox_claude` | **Only when user explicitly requests** |

**Important**: Always prefer `sandbox_command` for standard operations. Only use `sandbox_claude` when the user specifically asks for Claude AI assistance.

---

## Usage Examples

### Scenario 1: Run Python Script

```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "cd /home/user && python -m pip install requests && python app.py"
  }
}
```

### Scenario 2: Install System Packages (AlmaLinux)

```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "dnf install -y gcc make && gcc --version"
  }
}
```

### Scenario 3: File Management

```json
// 1. List files
{
  "name": "sandbox_list_files",
  "arguments": {
    "path": "/home/user"
  }
}

// 2. Read file
{
  "name": "sandbox_read_file",
  "arguments": {
    "file_path": "/home/user/data.json"
  }
}

// 3. Write file
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/result.txt",
    "content": "Processing complete: Success"
  }
}
```

### Scenario 4: Git Operations

```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "git clone https://github.com/user/repo.git && cd repo && git checkout -b feature"
  }
}
```

### Scenario 5: Using Claude (Only When Explicitly Requested)

**Example user request**: "Please use Claude to generate a presentation about AI"

```json
{
  "name": "sandbox_claude",
  "arguments": {
    "prompt": "Create a 5-page presentation about the history of artificial intelligence"
  }
}
```

**Note**: This scenario should only be used when the user explicitly asks for Claude assistance.

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
- **Read file limit**: 1MB (configurable)
- **Write file limit**: 10MB (configurable)
- **Upload file limit**: 100MB (configurable)
- **Command timeout**: 300 seconds (5 minutes)
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

1. **Clear Task Descriptions** - Provide detailed instructions and expected outcomes
2. **Use Absolute Paths** - Avoid path ambiguity
3. **Choose the Right Tool** - Refer to the tool selection guide
4. **Check Return Results** - Verify the `success` field
5. **Mind Size Limits** - File read/write operations have size constraints
6. **Prefer sandbox_command** - Use for most tasks; only use `sandbox_claude` when user explicitly requests Claude assistance

---

## Troubleshooting

### Sandbox Creation Failed
**Cause**: Executor Manager unavailable
**Solution**: Check service status and configuration

### File Not Found
**Cause**: Incorrect path or file doesn't exist
**Solution**: Use absolute paths, verify with `sandbox_list_files` first

### Command Timeout
**Cause**: Task execution takes too long
**Solution**: Increase timeout setting or split into smaller tasks

### File Too Large
**Cause**: Exceeds size limit (1MB read / 10MB write)
**Solution**: Process in chunks or adjust configuration

### Permission Denied
**Cause**: Insufficient file permissions
**Solution**: Check file paths and permission settings

---

## Technical Support

When troubleshooting issues, consult:
- Executor Manager logs
- Sandbox container logs
- E2B SDK documentation
