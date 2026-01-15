# Executor Manager

[中文](README_zh.md) | English

## Quick Start (Recommended)

Use the one-click startup script for automatic setup:

```bash
cd executor_manager
./start.sh
```

The script will automatically:
- Check Python version (3.8+ required)
- Install uv if not present
- Sync dependencies with uv
- Check Docker installation and status
- Create Docker network if needed
- Set PYTHONPATH
- Detect Docker host IP
- Start the Executor Manager server

**Custom Configuration:**
```bash
# Use custom port
./start.sh --port 8002

# Use custom executor image
./start.sh --executor-image ghcr.io/wecode-ai/wegent-executor:latest

# Use custom backend API
./start.sh --task-api-domain http://backend:8000

# View all options
./start.sh --help
```

**Port Validation:**
- The script validates port numbers (1-65535)
- Checks if ports are already in use
- Provides clear error messages with troubleshooting hints

## Manual Setup

If you prefer manual setup:

### Prerequisites

- [uv](https://github.com/astral-sh/uv) installed
- Docker installed and running

### Setup

1. Initialize the environment and install dependencies:
    ```bash
    uv sync
    ```

2. Set up `PYTHONPATH` to include the project root (required for `shared` module):
    ```bash
    # Run this from the project root (Wegent directory)
    export PYTHONPATH=$(pwd):$PYTHONPATH
    ```

### Running

Run the application (example with environment variables):
```bash
# Navigate to executor_manager directory
cd executor_manager

# Run with uv
EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:latest DOCKER_HOST_ADDR={LocalHost IP} uv run main.py
```

> EXECUTOR_IMAGE: Check docker-compose.yml for the latest wegent-executor image version
> DOCKER_HOST_ADDR: Set it to the host machine's IP address (the IP that containers can reach)

### Testing

Run tests:
```bash
# Ensure PYTHONPATH is set as above
uv run pytest
```
