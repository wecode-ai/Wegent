---
description: "Provides isolated sandbox execution environments for safely executing commands, running code, and managing filesystems. Ideal for code testing, file management, and command execution. The sandbox_claude tool is available for advanced use cases but should only be used when explicitly requested by the user."
displayName: "Sandbox Environment"
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
---

# Sandbox Environment

Execute code, commands, and complex tasks securely in isolated Docker containers.

## Core Capabilities

The sandbox environment provides fully isolated execution spaces with:

1. **Command Execution** - Run shell commands, scripts, and programs
2. **File Operations** - Read/write files, browse directories, manage filesystems
3. **Code Execution** - Safely execute and test code
4. **Claude AI Tasks** - Available for advanced use cases when explicitly requested by users

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
- `timeout` (optional): Timeout in seconds

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

**Parameters:**
- `file_path` (required): File path to write
- `content` (required): Content to write

**Features:**
- Automatically creates parent directories
- Maximum file size: 10MB (configurable)

**Example:**
```json
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/output.txt",
    "content": "Hello, Sandbox!"
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

### Scenario 2: File Management

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

### Scenario 3: Git Operations

```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "git clone https://github.com/user/repo.git && cd repo && git checkout -b feature"
  }
}
```

### Scenario 4: Using Claude (Only When Explicitly Requested)

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

### Lifecycle
- New sandbox created on first tool call
- Subsequent calls in the same session reuse the sandbox
- Sandbox persists for 30 minutes by default
- Files persist within the session
- Each sandbox runs in an isolated Docker container

### Resource Limits
- **Read file limit**: 1MB (configurable)
- **Write file limit**: 10MB (configurable)
- **Command timeout**: 300 seconds (5 minutes)
- **Claude timeout**: 1800 seconds (30 minutes)
- **Total task timeout**: 7200 seconds (2 hours)

### Security Features
- ✅ Fully isolated Docker containers
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
