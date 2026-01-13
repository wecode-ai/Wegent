---
description: "Use this skill to create a specialized code execution environment (SubAgent) for complex tasks requiring code execution, file operations, or Git operations. Suitable for: code generation and execution, file reading/writing/modification, Git repository operations, and complex multi-step programming tasks."
displayName: "Code Execution Assistant"
version: "1.0.0"
author: "Wegent Team"
tags: ["subagent", "code-execution", "automation"]
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
---

# SubAgent - Code Execution Assistant

This skill enables Chat Shell agents to delegate complex tasks requiring code execution, file operations, or Git operations to specialized SubAgents running in isolated Docker environments.

## When to Use This Skill

Use this skill when you encounter tasks that require:

1. **Code Execution**: Running scripts, executing commands, or testing code
2. **File Operations**: Reading, writing, or modifying files in a repository
3. **Git Operations**: Cloning repositories, creating branches, committing changes
4. **Complex Multi-step Programming Tasks**: Tasks that require multiple sequential operations

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

## Error Handling

If the SubAgent fails, you should:

1. Analyze the error message
2. Consider simplifying the task
3. Retry with clearer instructions if appropriate
4. Inform the user about the failure and suggest alternatives
