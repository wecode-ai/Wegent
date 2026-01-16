---
description: "Use this skill to create a specialized code execution environment (SubAgent) for complex tasks, execute shell commands, and perform file system operations in a sandbox. Tools: create_subagent_task for multi-step programming tasks, sandbox_command for shell execution, sandbox_list_files/read_file/write_file/make_dir/remove_file for file operations. Suitable for: code generation, file management, Git operations, and command execution."
displayName: "Code Execution & File Management Assistant"
version: "2.1.0"
author: "Wegent Team"
tags: ["subagent", "code-execution", "automation", "filesystem"]
bindShells: ["Chat"]
provider:
  module: provider
  class: SubAgentToolProvider
tools:
  - name: create_subagent_task
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
      bot_config:
        - shell_type: "ClaudeCode"
          agent_config:
            env:
              model: "claude"
              api_key: "xxxxx"
              base_url: "xxxxx"
              model_id: "xxxxxx"
              small_model: "xxxxxx"
  - name: sandbox_command
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
      command_timeout: 300
  - name: sandbox_list_files
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
  - name: sandbox_read_file
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
      max_file_size: 1048576
  - name: sandbox_write_file
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
      max_file_size: 10485760
  - name: sandbox_make_dir
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
  - name: sandbox_remove_file
    provider: subagent
    config:
      default_shell_type: "ClaudeCode"
      timeout: 7200
---

# SubAgent - Code Execution & File Management Assistant

This skill enables Chat Shell agents to execute code, commands, and manage files in isolated Docker environments. It provides seven powerful tools:

1. **create_subagent_task**: Delegate complex multi-step programming tasks to specialized SubAgents
2. **sandbox_command**: Execute shell commands directly in a sandbox environment
3. **sandbox_list_files**: List files and directories in the sandbox filesystem
4. **sandbox_read_file**: Read file contents from the sandbox
5. **sandbox_write_file**: Write content to files in the sandbox
6. **sandbox_make_dir**: Create directories in the sandbox
7. **sandbox_remove_file**: Remove files or directories from the sandbox

## When to Use This Skill

Use this skill when you encounter tasks that require:

1. **Code Execution**: Running scripts, executing commands, or testing code
2. **File Operations**: Reading, writing, listing, or modifying files in a sandbox
3. **Directory Management**: Creating directory structures in the sandbox
4. **Git Operations**: Cloning repositories, creating branches, committing changes
5. **Shell Commands**: Quick command execution without SubAgent overhead
6. **Complex Multi-step Programming Tasks**: Tasks that require multiple sequential operations
7. **Filesystem Exploration**: Browsing and exploring sandbox filesystem structure

## Tool: create_subagent_task

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_prompt` | string | Yes | Detailed description of the task for the SubAgent to execute |
| `shell_type` | string | No | Execution environment type: "ClaudeCode" (default) or "Agno" |
| `workspace_ref` | string | No | Name of the Workspace (repository) to work with, if applicable |

### Example Usage

```json
{
  "name": "create_subagent_task",
  "arguments": {
    "task_prompt": "Create a Python script that calculates fibonacci numbers, save it as fibonacci.py, and output the complete absolute file path where the file was saved",
    "shell_type": "ClaudeCode"
  }
}
```

### With Workspace Reference

```json
{
  "name": "create_subagent_task",
  "arguments": {
    "task_prompt": "Fix the bug in the login function in src/auth.py - the password validation is not working correctly",
    "shell_type": "ClaudeCode",
    "workspace_ref": "my-project"
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success**:
  - `success`: true
  - `result`: The execution result from the SubAgent
  - `execution_time`: Time taken in seconds

- **On Failure**:
  - `success`: false
  - `error`: Error message describing what went wrong

## Shell Types

### ClaudeCode (Default)

Best for:
- Complex code generation and modification
- Multi-step programming tasks
- Git operations and repository management
- Tasks requiring Claude Code SDK capabilities

### Agno

Best for:
- Tasks requiring team collaboration patterns
- Multi-agent coordination scenarios
- Tasks requiring specific Agno framework features

## Important Notes

1. **Task Description**: Provide clear, detailed task descriptions. The SubAgent will execute based solely on the prompt you provide.

2. **File Operations - Output Complete Paths**:
   - **CRITICAL**: When the task involves writing, creating, or modifying files, **always instruct the SubAgent to output the complete absolute file paths** in the result.
   - This helps users locate the files easily and understand what was changed.
   - **Good example**: "Create a Python script that calculates fibonacci numbers, save it as /workspace/fibonacci.py, and output the complete absolute file path"
   - **Bad example**: "Create a Python script called fibonacci.py" (path unclear, user won't know where it was saved)

3. **Workspace Reference**: If your task involves a specific repository, provide the workspace_ref to give the SubAgent access to the codebase.

4. **Timeout**: Default timeout is 2 hours (7200 seconds). Complex tasks may complete within this time.

5. **Isolation**: Each SubAgent runs in an isolated Docker container, ensuring safe execution.

6. **Result Handling**: The main agent should process the SubAgent's result and communicate relevant information (especially file paths) to the user.

## Tool: sandbox_command

### Description

Execute shell commands directly in an isolated sandbox environment. This tool is ideal for quick command execution without the overhead of a full SubAgent task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | The shell command to execute |
| `working_dir` | string | No | Working directory for execution (default: /home/user) |
| `timeout_seconds` | integer | No | Command timeout in seconds (default: 300) |

### Example Usage

**Execute a simple command:**

```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "ls -la",
    "working_dir": "/home/user"
  }
}
```

**Run a script with custom timeout:**

```json
{
  "name": "sandbox_command",
  "arguments": {
    "command": "python analyze.py --input data.csv",
    "working_dir": "/workspace",
    "timeout_seconds": 600
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success** (exit_code = 0):
  - `success`: true
  - `stdout`: Standard output from the command
  - `stderr`: Standard error output (if any)
  - `exit_code`: 0
  - `execution_time`: Time taken in seconds
  - `sandbox_id`: ID of the sandbox where command was executed

- **On Failure** (exit_code ≠ 0):
  - `success`: false
  - `stdout`: Standard output from the command
  - `stderr`: Standard error output
  - `exit_code`: Non-zero exit code
  - `execution_time`: Time taken in seconds

### When to Use

Use `sandbox_command` instead of `create_subagent_task` when:
- You need to execute a single shell command
- The task doesn't require complex multi-step logic
- You want faster execution without SubAgent overhead
- The command output is straightforward to interpret

Use `create_subagent_task` when:
- You need complex multi-step programming tasks
- The task requires file operations across multiple files
- You need Git operations or repository management
- The task benefits from Claude Code SDK capabilities

## Error Handling

If the SubAgent fails, you should:

1. Analyze the error message
2. Consider simplifying the task
3. Retry with clearer instructions if appropriate
4. Inform the user about the failure and suggest alternatives

---

## File System Tools

The following tools provide direct access to the sandbox filesystem without requiring a full SubAgent task. These tools are faster and more efficient for simple file operations.

## Tool: sandbox_list_files

### Description

List files and directories in the sandbox filesystem. This tool provides detailed metadata about each entry including permissions, size, owner, and modification time.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Directory path to list (default: /home/user) |
| `depth` | integer | No | Depth of directory listing (default: 1) |

### Example Usage

**List files in default directory:**

```json
{
  "name": "sandbox_list_files",
  "arguments": {
    "path": "/home/user"
  }
}
```

**Recursive directory listing:**

```json
{
  "name": "sandbox_list_files",
  "arguments": {
    "path": "/home/user/project",
    "depth": 3
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success**:
  - `success`: true
  - `entries`: Array of file/directory entries
    - `name`: File/directory name
    - `path`: Absolute path
    - `type`: "file", "directory", or "symlink"
    - `size`: Size in bytes
    - `permissions`: File permissions (e.g., "0644")
    - `owner`: File owner
    - `group`: File group
    - `modified_time`: ISO 8601 timestamp
    - `symlink_target`: Target path (for symlinks only)
  - `total`: Total number of entries
  - `path`: Path that was listed
  - `sandbox_id`: ID of the sandbox

- **On Failure**:
  - `success`: false
  - `error`: Error message

## Tool: sandbox_read_file

### Description

Read the contents of a file from the sandbox filesystem. Supports both text and binary files.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file (absolute or relative to /home/user) |
| `format` | string | No | Read format: "text" (default) or "bytes" |

### Example Usage

**Read a text file:**

```json
{
  "name": "sandbox_read_file",
  "arguments": {
    "file_path": "/home/user/config.json"
  }
}
```

**Read a binary file:**

```json
{
  "name": "sandbox_read_file",
  "arguments": {
    "file_path": "/home/user/image.png",
    "format": "bytes"
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success**:
  - `success`: true
  - `content`: File content as string (or base64-encoded for bytes)
  - `size`: File size in bytes
  - `path`: Absolute path to the file
  - `format`: Format used for reading
  - `modified_time`: ISO 8601 timestamp
  - `sandbox_id`: ID of the sandbox

- **On Failure**:
  - `success`: false
  - `error`: Error message (e.g., "File not found", "File too large")

### Important Notes

1. **Size Limit**: Default maximum file size is 1MB (configurable)
2. **Binary Files**: When reading binary files, content is base64-encoded
3. **File Type Check**: The tool verifies the path is a file (not a directory)

## Tool: sandbox_write_file

### Description

Write content to a file in the sandbox filesystem. Creates or overwrites files with support for both text and binary content.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file (absolute or relative to /home/user) |
| `content` | string | Yes | Content to write (text or base64-encoded bytes) |
| `format` | string | No | Content format: "text" (default) or "bytes" |
| `create_dirs` | boolean | No | Create parent directories if needed (default: true) |

### Example Usage

**Write a text file:**

```json
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/output.txt",
    "content": "Hello, World!\nThis is a test file."
  }
}
```

**Write a binary file:**

```json
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/data.bin",
    "content": "SGVsbG8gV29ybGQh",
    "format": "bytes"
  }
}
```

**Write without creating parent directories:**

```json
{
  "name": "sandbox_write_file",
  "arguments": {
    "file_path": "/home/user/existing/file.txt",
    "content": "Content",
    "create_dirs": false
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success**:
  - `success`: true
  - `path`: Absolute path to the file
  - `size`: Number of bytes written
  - `format`: Format used for writing
  - `modified_time`: ISO 8601 timestamp
  - `sandbox_id`: ID of the sandbox

- **On Failure**:
  - `success`: false
  - `error`: Error message (e.g., "Content too large", "Invalid base64")

### Important Notes

1. **Size Limit**: Default maximum file size is 10MB (configurable)
2. **Auto-create Directories**: Parent directories are created automatically by default
3. **Binary Content**: For binary files, provide base64-encoded content with `format: "bytes"`
4. **Overwrite Behavior**: The tool overwrites existing files without warning

## Tool: sandbox_make_dir

### Description

Create a directory in the sandbox filesystem. Parent directories are automatically created if needed.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the directory (absolute or relative to /home/user) |

### Example Usage

**Create a single directory:**

```json
{
  "name": "sandbox_make_dir",
  "arguments": {
    "path": "/home/user/data"
  }
}
```

**Create nested directories:**

```json
{
  "name": "sandbox_make_dir",
  "arguments": {
    "path": "/home/user/project/src/components"
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success**:
  - `success`: true
  - `path`: Absolute path of the directory
  - `message`: Success message
  - `created`: true if directory was created, false if already exists
  - `sandbox_id`: ID of the sandbox

- **On Failure**:
  - `success`: false
  - `error`: Error message

### Important Notes

1. **Parent Directories**: All parent directories are created automatically
2. **Idempotent**: Returns success even if the directory already exists
3. **Path Normalization**: Relative paths are converted to absolute paths

## Tool: sandbox_remove_file

### Description

Remove a file or directory from the sandbox filesystem. Directories are removed recursively with all their contents.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file or directory to remove (absolute or relative to /home/user) |

### Example Usage

**Remove a single file:**

```json
{
  "name": "sandbox_remove_file",
  "arguments": {
    "path": "/home/user/old_data.txt"
  }
}
```

**Remove a directory:**

```json
{
  "name": "sandbox_remove_file",
  "arguments": {
    "path": "/home/user/temp_folder"
  }
}
```

**Remove nested directory:**

```json
{
  "name": "sandbox_remove_file",
  "arguments": {
    "path": "/home/user/project/build"
  }
}
```

### Return Value

The tool returns a JSON response with:

- **On Success**:
  - `success`: true
  - `path`: Absolute path that was removed
  - `message`: "File or directory removed successfully"
  - `sandbox_id`: ID of the sandbox

- **On Failure**:
  - `success`: false
  - `error`: Error message (e.g., "Path not found")

### Important Notes

1. **Recursive Removal**: Directories are removed recursively with all contents
2. **No Confirmation**: The tool removes files/directories without confirmation
3. **Path Normalization**: Relative paths are converted to absolute paths
4. **Permanent Deletion**: Removed files cannot be recovered

### ⚠️ Warning

This tool permanently deletes files and directories. Use with caution:
- Double-check the path before removing
- Be especially careful with wildcard patterns or variable paths
- Consider listing the directory first to confirm contents

---

## Tool Selection Guide

Choose the right tool for your task:

### Use `create_subagent_task` when:
- Complex multi-step programming tasks
- Multiple file operations across different files
- Git operations or repository management
- Tasks requiring Claude Code SDK capabilities
- Code generation with execution and validation

### Use `sandbox_command` when:
- Single shell command execution
- Quick command execution without SubAgent overhead
- Straightforward command output
- Testing or verifying system state

### Use `sandbox_list_files` when:
- Exploring filesystem structure
- Finding specific files or directories
- Checking file metadata (size, permissions, timestamps)
- Recursive directory browsing

### Use `sandbox_read_file` when:
- Reading configuration files
- Inspecting file contents
- Reading data files for processing
- Verifying file contents

### Use `sandbox_write_file` when:
- Creating new files
- Updating existing file contents
- Generating output files
- Saving processed data

### Use `sandbox_make_dir` when:
- Creating directory structures
- Preparing workspace directories
- Organizing file hierarchies
- Setting up project structure

### Use `sandbox_remove_file` when:
- Deleting temporary files
- Cleaning up old data
- Removing build artifacts
- Deleting directories recursively
- File cleanup and maintenance

---

## Sandbox Lifecycle

All tools share the same sandbox instance within a task execution:
- The first tool call creates a new sandbox
- Subsequent tool calls reuse the same sandbox
- Sandbox persists for the duration of the task (default: 30 minutes)
- Files created in the sandbox persist across tool calls
- Each sandbox runs in an isolated Docker container

## Security & Isolation

- **Isolation**: Each sandbox runs in a separate Docker container
- **User Permissions**: All operations run as the sandbox user
- **File System**: Sandboxes have their own isolated filesystem
- **Network**: Sandboxes have controlled network access
- **Resource Limits**: CPU, memory, and disk usage are constrained

## Best Practices

1. **Use Appropriate Tools**: Choose the right tool for the task (see Tool Selection Guide)
2. **Provide Clear Paths**: Use absolute paths when possible to avoid confusion
3. **Handle Errors**: Always check the `success` field in responses
4. **Size Limits**: Be aware of file size limits (1MB for read, 10MB for write)
5. **Cleanup**: Large files should be cleaned up to avoid disk usage issues
6. **Combine Operations**: Use `create_subagent_task` for complex workflows involving multiple operations

