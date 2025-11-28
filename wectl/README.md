# wectl - Wegent Command Line Tool

A kubectl-style CLI for managing Wegent resources.

## Installation

```bash
cd wectl
pip install -e .
```

Or install directly:

```bash
pip install -r requirements.txt
python -m wectl.cli
```

## Quick Start

### Configure Server

```bash
# Set API server
wectl config set server http://localhost:8000

# Set default namespace
wectl config set namespace default

# Set auth token (optional)
wectl config set token YOUR_TOKEN

# View configuration
wectl config view
```

You can also use environment variables:

```bash
export WECTL_SERVER=http://localhost:8000
export WECTL_NAMESPACE=default
export WECTL_TOKEN=YOUR_TOKEN
```

## Commands

### Get Resources

```bash
# List all resources of a kind
wectl get ghosts
wectl get bots
wectl get tasks

# Get specific resource
wectl get ghost my-ghost
wectl get bot my-bot

# Output formats
wectl get ghosts -o yaml
wectl get ghosts -o json

# Filter by name
wectl get tasks --filter test

# Specify namespace
wectl get bots -n production
```

### Describe Resources

```bash
# Show detailed information
wectl describe ghost my-ghost
wectl describe task task-001
```

### Create Resources

```bash
# Create with default template
wectl create ghost my-ghost
wectl create bot my-bot -n production

# Preview template without creating
wectl create team my-team --dry-run
```

### Apply Resources

```bash
# Apply from file
wectl apply -f ghost.yaml

# Apply multiple files
wectl apply -f ghost.yaml -f bot.yaml

# Apply all YAML files in directory
wectl apply -f ./resources/

# Override namespace
wectl apply -f bot.yaml -n production
```

### Delete Resources

```bash
# Delete specific resource
wectl delete ghost my-ghost

# Delete from file
wectl delete -f ghost.yaml

# Delete all resources of a kind
wectl delete bots --all

# Skip confirmation
wectl delete ghost my-ghost -y
```

### List Resource Types

```bash
wectl api-resources
```

## Resource Types

| Name       | Shortname | Description                      |
|------------|-----------|----------------------------------|
| ghost      | gh        | AI agent persona/prompt          |
| model      | mo        | LLM model configuration          |
| shell      | sh        | Runtime environment              |
| bot        | bo        | Combination of ghost+shell+model |
| team       | te        | Group of bots                    |
| workspace  | ws        | Git repository configuration     |
| task       | ta        | Execution task                   |
| skill      | sk        | Reusable AI skill                |

## Resource YAML Examples

### Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: my-ghost
  namespace: default
spec:
  systemPrompt: "You are a helpful coding assistant."
  mcpServers: {}
  skills: []
```

### Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
  namespace: default
spec:
  ghostRef:
    name: my-ghost
    namespace: default
  shellRef:
    name: claude-code
    namespace: default
```

### Team

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: my-team
  namespace: default
spec:
  members:
    - botRef:
        name: my-bot
        namespace: default
      role: developer
      prompt: "Handle coding tasks"
  collaborationModel: pipeline
```

### Task

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: my-task
  namespace: default
spec:
  title: "Fix bug"
  prompt: "Fix the authentication bug in login.py"
  teamRef:
    name: my-team
    namespace: default
  workspaceRef:
    name: my-workspace
    namespace: default
```

## License

Apache License 2.0
