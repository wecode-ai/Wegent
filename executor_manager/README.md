# Executor Manager

[中文](README_zh.md) | English

## Local Development

### Prerequisites

- [uv](https://github.com/astral-sh/uv) installed.

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
EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:{version} DOCKER_HOST_ADDR={LocalHost IP} uv run main.py
```

> EXECUTOR_IMAGE: Check docker-compose.yml for the latest wegent-executor image version
> DOCKER_HOST_ADDR: Set it to the host machine’s IP address (the IP that containers can reach)

### Testing

Run tests:
```bash
# Ensure PYTHONPATH is set as above
uv run pytest
```
