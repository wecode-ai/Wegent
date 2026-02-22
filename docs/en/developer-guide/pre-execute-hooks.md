# Pre-Execute Hooks

Pre-execute hooks allow you to run custom scripts before task execution in the Executor. This is useful for custom initialization, security checks, environment setup, or integration with external systems.

---

## Overview

The pre-execute hook system provides a way to execute external commands before each task starts. The hook receives information about the task and can perform any necessary setup or validation.

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WEGENT_HOOK_PRE_EXECUTE` | Path to the hook script | Not set (disabled) |
| `WEGENT_HOOK_PRE_EXECUTE_TIMEOUT` | Timeout in seconds | 30 |

### Enabling the Hook

Set the `WEGENT_HOOK_PRE_EXECUTE` environment variable to the path of your hook script:

```bash
export WEGENT_HOOK_PRE_EXECUTE=/path/to/your/pre-execute-hook.sh
```

---

## Hook Interface

### Arguments

The hook script is called with:

```bash
bash <script_path> <task_dir>
```

| Argument | Description |
|----------|-------------|
| `task_dir` | The task's working directory path |

### Environment Variables

The following environment variables are passed to the hook:

| Variable | Description |
|----------|-------------|
| `WEGENT_TASK_DIR` | Task working directory |
| `WEGENT_TASK_ID` | Task ID |
| `WEGENT_GIT_URL` | Git repository URL |

### Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0` | Success - task execution continues |
| Non-zero | Failure - logged as warning, task execution continues |
| `-1` (internal) | Timeout or script not found |

---

## Example Hook Script

```bash
#!/bin/bash
# Pre-execute hook example
# Save as: /opt/wegent/hooks/pre-execute.sh

TASK_DIR="$1"

echo "Pre-execute hook running"
echo "Task Directory: $TASK_DIR"
echo "Task ID: $WEGENT_TASK_ID"
echo "Git URL: $WEGENT_GIT_URL"

# Example: Create a marker file
touch "$TASK_DIR/.hook-executed"

# Example: Run security scan
# /opt/security/scan.sh "$TASK_DIR"

# Example: Set up custom environment
# source /opt/custom/env.sh

exit 0
```

---

## Use Cases

### 1. Security Scanning

Run security checks on the repository before execution:

```bash
#!/bin/bash
TASK_DIR="$1"

# Run security scan
if ! /opt/security/scanner --path "$TASK_DIR"; then
    echo "Security scan failed"
    exit 1
fi

exit 0
```

### 2. Custom Initialization

Set up custom tools or configurations:

```bash
#!/bin/bash
TASK_DIR="$1"

# Copy custom configuration files
cp /opt/configs/.custom "$TASK_DIR/"

# Initialize custom tools
/opt/tools/init.sh "$TASK_DIR"

exit 0
```

### 3. Logging and Auditing

Log task execution for auditing:

```bash
#!/bin/bash
TASK_DIR="$1"

# Log to audit system
echo "$(date) - Task $WEGENT_TASK_ID started - $WEGENT_GIT_URL" >> /var/log/wegent/audit.log

exit 0
```

---

## Docker Configuration

When running Wegent in Docker, mount your hook script and set the environment variable:

```yaml
# docker-compose.yml
services:
  executor:
    environment:
      - WEGENT_HOOK_PRE_EXECUTE=/hooks/pre-execute.sh
      - WEGENT_HOOK_PRE_EXECUTE_TIMEOUT=60
    volumes:
      - ./hooks:/hooks:ro
```

---

## Troubleshooting

### Hook Not Executing

1. Verify the script path is correct and accessible
2. Check that the script has execute permissions (`chmod +x`)
3. Check the Executor logs for hook-related messages

### Hook Timeout

If your hook takes longer than the default 30 seconds:

```bash
export WEGENT_HOOK_PRE_EXECUTE_TIMEOUT=120
```

### Debugging

Enable verbose logging to see hook execution details in the Executor logs:

```bash
# The hook logs include:
# - Command being executed
# - Task directory and ID
# - stdout and stderr from the script
# - Exit code
```

---

## Related

- [System Architecture](../../concepts/architecture.md) - Overview of Wegent's architecture
- [Developer Setup](./setup.md) - Setting up the development environment
