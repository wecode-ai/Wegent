# wegent - Wegent Command Line Tool

A kubectl-style CLI for managing Wegent resources.

## Installation

### Quick Install (Recommended)

Install both wegent CLI and executor binary with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/wegent-cli/install-cli.sh | bash
```

This script will automatically:
- Detect your platform (Linux/macOS/Windows) and architecture (amd64/arm64)
- Try to install wegent CLI from PyPI via pip/pipx
- If PyPI is not available, download from GitHub releases
- If no release wheel found, clone repository and install from source
- Download and install the latest executor binary to `~/.wegent/bin/`
- Verify the installation

**Requirements:**
- Python 3.10 or higher
- pip3 or pipx
- curl
- git (for source installation fallback)

### Manual Installation

#### Option 1: Install from PyPI (when published)

```bash
# Install via pip
pip install wegent

# Or install via pipx (recommended for better isolation)
pipx install wegent
```

#### Option 2: Install from GitHub Release

```bash
# Download and install wheel from GitHub releases
pip install https://github.com/wecode-ai/Wegent/releases/download/v1.1.0/wegent-1.1.0-py3-none-any.whl
```

#### Option 3: Install from Source

```bash
# Clone repository
git clone https://github.com/wecode-ai/Wegent.git
cd Wegent/wegent-cli

# Install
pip install .

# Or install in editable mode for development
pip install -e .
```

#### Install Executor Binary

After installing CLI, download and install the executor binary:

```bash
wegent executor update
```

### Development Installation

```bash
cd wegent-cli
pip install -e .
```

### Troubleshooting

#### Pip Version Issues

If you encounter issues with editable install on older pip versions (< 21.3), upgrade pip first:

```bash
pip install --upgrade pip
pip install -e .
```

#### New Commands Not Appearing After Update

If you've updated the code but new commands don't appear when running `wegent --help`:

1. **Clear Python bytecode cache:**
   ```bash
   find wegent-cli -name "*.pyc" -delete
   find wegent-cli -type d -name "__pycache__" -exec rm -r {} + 2>/dev/null || true
   ```

2. **Reinstall in editable mode:**
   ```bash
   cd wegent-cli
   pip uninstall wegent -y
   pip install -e . --no-cache-dir
   ```

3. **Rehash shell and pyenv (if using pyenv):**
   ```bash
   hash -r
   pyenv rehash  # if using pyenv
   ```

4. **Check for conflicting installations:**
   ```bash
   # If you still have issues, check for old installation paths
   python -c "import wegent.cli; import inspect; print(inspect.getsourcefile(wegent.cli))"

   # The output should point to your current project directory
   # If it points elsewhere, you may have a conflicting installation
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

### Manage Local Executor

```bash
# Start executor in foreground
wegent executor start

# Start executor in background (daemon mode)
wegent executor start -d
# or
wegent executor start --detach

# Stop executor
wegent executor stop

# Restart executor
wegent executor restart
wegent executor restart -d    # Restart in background

# Check installed executor version
wegent executor version

# Install/update executor binary to latest version
# (skips download if already up-to-date)
wegent executor update

# Force reinstall even if up-to-date
wegent executor update --force

# Install specific version
wegent executor update -v v1.0.0
# or
wegent executor update --version v1.0.0

# Rollback to previous version
wegent executor rollback
```

**Executor file locations:**
- Binary: `~/.wegent/bin/wegent-executor`
- Version info: `~/.wegent/bin/.executor-version`
- Logs: `~/.wegent/logs/executor.log`
- PID file: `~/.wegent/run/executor.pid`

### Upgrade CLI

```bash
# Upgrade wegent CLI to latest version
# - For git installations: runs 'git pull'
# - For pip installations: runs 'pip install --upgrade wegent-cli'
wegent upgrade
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
