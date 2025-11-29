# wegent - Wegent Command Line Tool

A kubectl-style CLI for managing Wegent resources.

## Installation

```bash
cd wegent-cli
pip install -e .
```

Or install directly:

```bash
pip install -r requirements.txt
python -m wegent.cli
```

## Quick Start

### Login

```bash
# Interactive login (recommended)
wegent login

# Login with credentials
wegent login -u admin -p yourpassword

# Login to specific server
wegent login -s http://api.example.com

# Logout
wegent logout
```

### Configure Server

```bash
# Set API server
wegent config set server http://localhost:8000

# Set default namespace
wegent config set namespace default

# Set auth token (manual, alternative to login)
wegent config set token YOUR_TOKEN

# View configuration
wegent config view
```

You can also use environment variables:

```bash
export WEGENT_SERVER=http://localhost:8000
export WEGENT_NAMESPACE=default
export WEGENT_TOKEN=YOUR_TOKEN
```

## Commands

### Get Resources

```bash
# List all resources of a kind
wegent get ghosts
wegent get bots
wegent get tasks

# Get specific resource
wegent get ghost my-ghost
wegent get bot my-bot

# Output formats
wegent get ghosts -o yaml
wegent get ghosts -o json

# Filter by name
wegent get tasks --filter test

# Specify namespace
wegent get bots -n production
```

### Describe Resources

```bash
# Show detailed information
wegent describe ghost my-ghost
wegent describe task task-001
```

### Create Resources

```bash
# Create with default template
wegent create ghost my-ghost
wegent create bot my-bot -n production

# Preview template without creating
wegent create team my-team --dry-run
```

### Apply Resources

```bash
# Apply from file
wegent apply -f ghost.yaml

# Apply multiple files
wegent apply -f ghost.yaml -f bot.yaml

# Apply all YAML files in directory
wegent apply -f ./resources/

# Override namespace
wegent apply -f bot.yaml -n production
```

### Delete Resources

```bash
# Delete specific resource
wegent delete ghost my-ghost

# Delete from file
wegent delete -f ghost.yaml

# Delete all resources of a kind
wegent delete bots --all

# Skip confirmation
wegent delete ghost my-ghost -y
```

### List Resource Types

```bash
wegent api-resources
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
