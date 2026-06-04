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
wegent kind get ghosts
wegent kind get bots
wegent kind get tasks

# Get specific resource
wegent kind get ghost my-ghost
wegent kind get bot my-bot

# Output formats
wegent kind get ghosts
wegent kind get ghosts --json

# Specify namespace
wegent kind get bots -n production
```

### Describe Resources

```bash
# Show detailed information
wegent kind describe ghost my-ghost
wegent kind describe task task-001
```

### Apply Resources

```bash
# Apply from file
wegent kind apply --file ghost.yaml

# Apply from stdin
cat resources.yaml | wegent kind apply --input -

# Output JSON envelope
wegent kind apply --file ghost.yaml --json

# Override namespace
wegent kind apply --file bot.yaml -n production
```

### Delete Resources

```bash
# Delete specific resource
wegent kind delete ghost my-ghost

# Delete from structured input
wegent kind delete --input ghost.yaml

# Output JSON envelope
wegent kind delete ghost my-ghost --json
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
