# Executor Module Local Development Guide

## Overview

Executor is the task execution module of the Wegent project, responsible for receiving and processing task requests. This module is built on FastAPI and provides RESTful API interfaces for task execution and management.

## Project Structure

```
executor/
├── agents/              # Agent implementations
│   ├── agno/           # Agno Agent implementation
│   ├── claude_code/    # Claude Code Agent implementation
│   ├── base.py         # Agent base class
│   └── factory.py      # Agent factory
├── callback/           # Callback handling
├── config/             # Configuration management
├── services/           # Business service layer
├── tasks/              # Task processing
├── utils/              # Utility functions
├── tests/              # Test cases
├── main.py             # Application entry point
└── requirements.txt    # Dependency list
```

## Local Setup

> **⚠️ Important Notes**:
> 1. All operations must be performed in the **project root directory (Wegent/)**, not the executor subdirectory
> 2. You must set the `export PYTHONPATH=$(pwd)` environment variable
> 3. It's recommended to use uv's virtual environment to isolate project dependencies

### Requirements

- Python 3.8+
- uv (recommended Python package manager)

### Installing uv

If you haven't installed uv yet, you can install it with the following commands:

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or install via pip
pip install uv
```

### Step 1: Create Virtual Environment

> **Important**: The virtual environment must be created in the **project root directory**, not the executor subdirectory.

Create and activate a virtual environment using uv:

```bash
# Ensure you're in the project root directory (Wegent/)
cd /path/to/Wegent

# Create virtual environment (based on project Python version)
uv venv

# Activate virtual environment
# Linux/macOS:
source .venv/bin/activate

# Windows:
# .venv\Scripts\activate
```

### Step 2: Install Dependencies

Install project dependencies in the virtual environment:

```bash
# Ensure you're in the project root directory
cd /path/to/Wegent

# Install executor module dependencies
uv pip install -r executor/requirements.txt
```

### Step 3: Configure Environment Variables

Executor requires the following environment variables:

#### Required Environment Variables

```bash
# Python path configuration (Required!)
export PYTHONPATH=$(pwd)

# API key configuration
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export OPENAI_API_KEY="your-openai-api-key"  # If using OpenAI models

# Workspace configuration
export WORKSPACE_ROOT="/path/to/your/workspace"  # Default: /workspace/

# Service port
export PORT=10001  # Default: 10001
```

#### Optional Environment Variables

```bash
# Callback URL (for task status callbacks)
export CALLBACK_URL="http://your-callback-service/executor-manager/callback"

# Executor identification (used in K8s environment)
export EXECUTOR_NAME="local-executor"
export EXECUTOR_NAMESPACE="default"

# Debug mode
export DEBUG_RUN="true"

# Custom configuration (JSON format)
export EXECUTOR_ENV='{}'
```

#### Task Information (Optional, for auto-execution on startup)

```bash
# TASK_INFO contains detailed task information
export TASK_INFO='{"task_id": 1, "subtask_id": 1, "agent_type": "claude_code", ...}'
```

### Step 4: Start the Service

> **Note**: The service must be started from the **project root directory** with PYTHONPATH set.

Run the service using uv in the virtual environment:

```bash
# Ensure you're in the project root directory (Wegent/)
cd /path/to/Wegent

# Ensure virtual environment is activated
# If not activated, run: source .venv/bin/activate

# Set PYTHONPATH (Required!)
export PYTHONPATH=$(pwd)

# Method 1: Run directly using uv
uv run python -m executor.main

# Method 2: Run with uvicorn (more control options, recommended for development)
uv run uvicorn executor.main:app --host 0.0.0.0 --port 10001 --reload

# Method 3: Run directly in activated virtual environment
python -m executor.main
# Or
uvicorn executor.main:app --host 0.0.0.0 --port 10001 --reload
```

#### Startup Parameter Explanation

- `--host 0.0.0.0`: Listen on all network interfaces
- `--port 10001`: Specify service port (default 10001)
- `--reload`: Enable hot reload, automatically restart after code changes (development only)

### Step 5: Verify Service

After the service starts, you can verify it with:

```bash
# Check service health
curl http://localhost:10001/docs

# View API documentation
# Open in browser: http://localhost:10001/docs
```

## API Endpoints

Executor provides the following main API endpoints:

### 1. Execute Task

```bash
POST /api/tasks/execute
Content-Type: application/json

{
  "task_id": 1,
  "subtask_id": 1,
  "agent_type": "claude_code",
  "task_title": "Task Title",
  "subtask_title": "Subtask Title",
  "content": "Task Content",
  "repo_url": "https://github.com/example/repo.git",
  "branch": "main",
  "git_username": "user",
  "git_password": "password"
}
```

### 2. List All Sessions

```bash
GET /api/tasks/sessions
```

### 3. Delete Specific Session

```bash
DELETE /api/tasks/session?task_id=1
```

### 4. Close All Claude Sessions

```bash
DELETE /api/tasks/claude/sessions
```

### 5. Close All Agent Sessions

```bash
DELETE /api/tasks/sessions/close
```

## Quick Start Script Example

Create a `start.sh` script for quick startup:

```bash
#!/bin/bash

# Must run from project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Set PYTHONPATH (Required!)
export PYTHONPATH=$(pwd)

# Set other environment variables
export ANTHROPIC_API_KEY="your-api-key"
export WORKSPACE_ROOT="./workspace"
export PORT=10001
export DEBUG_RUN="true"

# Create workspace directory
mkdir -p $WORKSPACE_ROOT

# Create virtual environment (if it doesn't exist)
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    uv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source .venv/bin/activate

# Install dependencies (first run or when updating dependencies)
echo "Installing dependencies..."
uv pip install -r executor/requirements.txt

# Start service
echo "Starting executor service..."
echo "PYTHONPATH is set to: $PYTHONPATH"
uv run uvicorn executor.main:app --host 0.0.0.0 --port $PORT --reload
```

Usage:

```bash
# Create script in project root directory
cd /path/to/Wegent
chmod +x start.sh
./start.sh
```

## Development & Debugging

### Viewing Logs

Executor uses structured logging, which outputs to the console:

```bash
# Log format
2025-01-10 10:30:00 - task_executor - INFO - Starting task execution...
```

### IDE Debugging

#### VS Code Configuration

Add the following configuration to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Executor Debug",
      "type": "python",
      "request": "launch",
      "module": "uvicorn",
      "args": [
        "executor.main:app",
        "--host", "0.0.0.0",
        "--port", "10001",
        "--reload"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "your-api-key",
        "WORKSPACE_ROOT": "./workspace",
        "DEBUG_RUN": "true"
      },
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal"
    }
  ]
}
```

### Running Tests

Run tests in the virtual environment:

```bash
# Ensure virtual environment is activated
source .venv/bin/activate

# Install test dependencies
uv pip install pytest pytest-asyncio

# Run all tests
uv run pytest
# Or in activated virtual environment
pytest

# Run specific test file
uv run pytest tests/agents/test_factory.py

# Run tests with verbose output
uv run pytest -v

# Run tests with coverage report
uv run pytest --cov=executor --cov-report=html
```

## Troubleshooting

### 1. Port Already in Use

Error message: `[Errno 48] Address already in use`

Solution:
```bash
# Find process using the port
lsof -i :10001

# Kill the process
kill -9 <PID>

# Or use a different port
export PORT=10002
```

### 2. API Key Not Configured

Error message: `API key not configured`

Solution:
```bash
# Ensure you set the correct API key
export ANTHROPIC_API_KEY="your-actual-api-key"
```

### 3. Workspace Path Does Not Exist

Error message: `Workspace directory does not exist`

Solution:
```bash
# Create workspace directory
mkdir -p /path/to/workspace
export WORKSPACE_ROOT="/path/to/workspace"
```

### 4. Virtual Environment Not Activated

Error message: `ModuleNotFoundError: No module named 'xxx'`

Solution:
```bash
# Activate virtual environment (ensure you're in project root)
cd /path/to/Wegent
source .venv/bin/activate

# Confirm virtual environment is activated ((.venv) will appear in command prompt)
# Then re-run the command
```

### 5. PYTHONPATH Not Set

Error message: `ModuleNotFoundError: No module named 'shared'` or `ModuleNotFoundError: No module named 'executor'`

Solution:
```bash
# Must set PYTHONPATH from project root directory
cd /path/to/Wegent
export PYTHONPATH=$(pwd)

# Confirm PYTHONPATH is set
echo $PYTHONPATH

# Then re-run startup command
```

### 6. Running in Wrong Directory

Error message: Various module import errors

Solution:
```bash
# Ensure you're in project root directory (Wegent/) not executor/ subdirectory
cd /path/to/Wegent  # Correct
# Don't run from /path/to/Wegent/executor directory

# Set PYTHONPATH
export PYTHONPATH=$(pwd)

# Then run startup command
uv run uvicorn executor.main:app --host 0.0.0.0 --port 10001 --reload
```

### 7. uv Command Not Found

Error message: `command not found: uv`

Solution:
```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or install via pip
pip install uv

# Reload shell configuration
source ~/.bashrc  # or source ~/.zshrc
```

## Next Steps

- [Agent Development Guide](./AGENT_DEV.md) (TODO)
- [Configuration Details](./CONFIG.md) (TODO)
- [Deployment Guide](./DEPLOYMENT.md) (TODO)
- [API Reference Documentation](./API.md) (TODO)

## License

Apache License 2.0 - See LICENSE file in project root directory
