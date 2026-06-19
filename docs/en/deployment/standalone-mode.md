---
sidebar_position: 3
---

# Standalone Mode Deployment

## Overview

Standalone mode is a single-machine deployment that packages Backend, the main Frontend, Wework Web, Chat Shell, and Redis into one Docker image, using SQLite as the database. It is intended for quick evaluation and small trusted environments, and only requires Docker. Interactive macOS installs default to a host executor so Claude Code or Codex can execute macOS system commands; Linux and non-interactive installs default to the in-container executor.

After startup, standalone automatically creates an executor API key for the `admin` user and registers devices according to the selected executor mode: the container executor registers as a built-in cloud device, the host executor registers as a local device, and Wework can use available devices directly for coding tasks. The default container workspace is mounted at `/workspace` and stores project directories, standalone chat workspaces, and Git worktrees; the host executor uses `~/.wegent-executor/workspace`.

When using the container executor, coding tasks execute directly inside the same standalone container, so the image is designed as a lightweight development environment rather than a minimal runtime. It includes basic development and diagnostics tools such as `ps`, `top`, `free`, `ip`, `ss`, `lsof`, `tree`, and `rg` by default. When using the host executor, tasks use Claude Code, Codex, and system commands from the host.

### Use Cases

- Single-machine deployment
- Development and testing
- Small trusted usage
- Quick evaluation of Wework coding tasks

### Architecture Comparison

| Feature | Standard Mode | Standalone Mode |
|---------|---------------|-----------------|
| Deployment Complexity | High (multi-container) | Low (single container) |
| Resource Usage | High | Medium |
| Scalability | Good | Limited |
| Task Isolation | Sandbox/cloud device | Container or host, depending on executor mode |
| Database | MySQL | SQLite |
| Redis | External | Embedded |
| Wework | Separate desktop app or Web | Built-in Wework Web |
| Use Case | Production | Dev/Test/Small-scale |

## Quick Start

### One Command Installation (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

This will automatically:

1. Check and install Docker if needed
2. Pull the latest Wegent standalone image
3. Create the `wegent-data` data volume and `wegent-workspace` workspace volume
4. Publish a single Nginx entry port
5. Start the container and wait for Backend and Wework readiness

After startup, open:

| Entry | URL | Purpose |
|-------|-----|---------|
| Main Frontend | `http://localhost:3000` | Wegent management and general features |
| Wework | `http://localhost:3000/wework` | Create and use coding tasks |
| Backend API | `http://localhost:3000/api` | API and WebSocket |

## Executor Location

Standalone supports three executor modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `host` | Backend, Frontend, and Wework run in Docker; the executor is downloaded from GitHub Releases and runs on the host | Default recommendation for macOS; required for `open`, `osascript`, system Terminal, Keychain-backed tools, and other host commands |
| `container` | The executor runs inside the standalone container | Linux quick start and existing single-container behavior |
| `hybrid` | Both the container executor and host executor run | Keep the container device while also using host-native capabilities |

On macOS, Docker Desktop containers run Linux processes, so Claude Code or Codex inside the container cannot directly execute macOS system commands. For that reason, interactive macOS installs default to `host`. Non-interactive installs still default to `container` for automation compatibility.

Explicit mode selection:

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | \
  bash -s -- --standalone --executor-mode host
```

Environment variable form:

```bash
WEGENT_STANDALONE_EXECUTOR_MODE=hybrid \
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

### Subsequent Starts

When installed through `curl | bash`, `install.sh` is not kept on the host. The installer writes
`~/.wegent/standalone/config.env` and installs a local management command:

```bash
~/.local/bin/wegent-standalone start
```

Common commands:

```bash
~/.local/bin/wegent-standalone status
~/.local/bin/wegent-standalone stop
~/.local/bin/wegent-standalone restart
~/.local/bin/wegent-standalone logs
~/.local/bin/wegent-standalone logs host
~/.local/bin/wegent-standalone update
```

`host` and `hybrid` modes need to manage both the Docker container and the host executor.
Running only `docker start wegent-standalone` starts the container but does not restore the host
executor, so subsequent starts should use `wegent-standalone start`.

### Running Container Directly

For local access:

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:3000 \
  -e RUNTIME_PUBLIC_API_URL=http://localhost:3000/api \
  -e RUNTIME_WEWORK_CODE_URL=http://localhost:3000/wework \
  -e WEWORK_PUBLIC_APP_BASE_PATH=/wework \
  -e WEWORK_PUBLIC_API_URL=/wework/api \
  -e WEWORK_PUBLIC_SOCKET_PATH=/wework/socket.io \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

For remote access, replace `YOUR_SERVER_IP` with your server IP or domain:

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://YOUR_SERVER_IP:3000 \
  -e RUNTIME_PUBLIC_API_URL=http://YOUR_SERVER_IP:3000/api \
  -e RUNTIME_WEWORK_CODE_URL=http://YOUR_SERVER_IP:3000/wework \
  -e WEWORK_PUBLIC_APP_BASE_PATH=/wework \
  -e WEWORK_PUBLIC_API_URL=/wework/api \
  -e WEWORK_PUBLIC_SOCKET_PATH=/wework/socket.io \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

`RUNTIME_WEWORK_CODE_URL` is served through the main Frontend runtime config, so coding entry points in the main Frontend open the bundled standalone Wework by default.

The standalone image includes Nginx, so browsers only need port `3000`. Nginx proxies `/` to the main Frontend, serves Wework Web static assets at `/wework`, and forwards `/wework/api` and `/wework/socket.io` to the Backend.

## Using Wework for Coding Tasks

1. Open `http://localhost:3000/wework` (use the server address for remote deployments).
2. Sign in with the initialized account, or follow the page prompts to finish account setup.
3. Configure an available model and provider token in settings.
4. Return to the Wework workbench and send a coding request directly.
5. If no project is selected, Wework routes the request to an automatically registered standalone executor device and creates a standalone chat workspace.
6. After creating a Git project, new tasks use the selected executor's workspace. The container executor uses `/workspace/projects` and `/workspace/worktrees`; the host executor uses `~/.wegent-executor/workspace`.
7. To inspect files or open a terminal, use the Wework project toolbar. Terminals are relayed through the authenticated Backend Socket.IO channel to the matching executor, which manages the PTY directly.

Standalone does not include the IDE/code-server entry by default. For the first standalone launch, treat Wework coding, workspace files, and project terminal as the primary capabilities. Use standard deployment or a separate cloud device when you need IDE access or stronger isolation.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RUNTIME_SOCKET_DIRECT_URL` | Backend WebSocket URL used by the main Frontend; empty means same-origin `/socket.io` | empty |
| `RUNTIME_PUBLIC_API_URL` | Public API URL displayed by the main Frontend | `/api` |
| `RUNTIME_WEWORK_CODE_URL` | Wework URL opened by the main Frontend coding entry points | `/wework` |
| `WEWORK_PUBLIC_APP_BASE_PATH` | Wework Web mount path | `/wework` |
| `WEWORK_PUBLIC_API_URL` | Wework Web API URL | `/wework/api` |
| `WEWORK_PUBLIC_SOCKET_URL` | Wework Web Socket.IO origin; empty means the current page origin | empty |
| `WEWORK_PUBLIC_SOCKET_PATH` | Wework Web Socket.IO path | `/wework/socket.io` |
| `WEGENT_WORKSPACE_ROOT` | Standalone workspace root | `/workspace` |
| `WEGENT_STANDALONE_EXECUTOR_MODE` | Standalone executor mode: `host`, `container`, or `hybrid` | `host` for interactive macOS installs; `container` for non-interactive and Linux installs |
| `STANDALONE_EXECUTOR_ENABLED` | In-container executor switch passed by the installer according to executor mode | `true` |
| `WEGENT_BIN_DIR` | Directory where the installer writes the `wegent-standalone` management command | `~/.local/bin` |
| `WEGENT_STANDALONE_STATE_FILE` | Persistent state file read by `wegent-standalone` | `~/.wegent/standalone/config.env` |
| `STANDALONE_MODE` | Enable standalone mode | `true` |
| `DATABASE_URL` | Database connection URL | `sqlite:////app/data/wegent.db` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379/0` |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |

### Data Persistence

Service state is stored in `/app/data`:

- `wegent.db`: SQLite database file
- `redis/`: Redis persistence data (AOF and RDB)
- `standalone_executor_token`: admin API key used by the standalone executor registration
- `standalone-executor/`: container executor local state

Workspace data is stored in `/workspace`:

- `projects/`: Wework Git project directories
- `chats/`: standalone chat workspaces without a selected project
- `worktrees/`: per-task Git worktrees

The host executor binary, config, logs, and workspace are stored in `~/.wegent-executor`.

Use Docker volumes for persistence:

```bash
docker volume create wegent-data
docker volume create wegent-workspace

docker run \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  ...
```

## Common Commands

```bash
# View logs
docker logs -f wegent-standalone

# Stop the container
docker stop wegent-standalone

# Start the container
docker start wegent-standalone

# Restart the container
docker restart wegent-standalone

# Remove the container (data and workspace remain in volumes)
docker rm -f wegent-standalone

# Update to latest version
docker pull ghcr.io/wecode-ai/wegent-standalone:latest
docker rm -f wegent-standalone
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:3000 \
  -e RUNTIME_PUBLIC_API_URL=http://localhost:3000/api \
  -e RUNTIME_WEWORK_CODE_URL=http://localhost:3000/wework \
  -e WEWORK_PUBLIC_APP_BASE_PATH=/wework \
  -e WEWORK_PUBLIC_API_URL=/wework/api \
  -e WEWORK_PUBLIC_SOCKET_PATH=/wework/socket.io \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## Building the Image

If you need to build the image yourself:

```bash
# Use the build script
./scripts/build-standalone.sh

# Specify a tag
./scripts/build-standalone.sh -t my-registry/wegent:v1.0

# Specify platform
./scripts/build-standalone.sh -p linux/amd64
```

## Important Notes

### SQLite Limitations

1. **Concurrent Writes**: SQLite is not suitable for high-concurrency writes; use it for single-user or small-scale usage
2. **Data Backup**: Regularly back up `/app/data/wegent.db` and `/workspace`

### Embedded Redis

The standalone image includes embedded Redis:

- Data is persisted to `/app/data/redis/`
- Uses AOF (Append Only File) for durability
- Memory is limited to 256MB with LRU eviction

### Standalone Executor Limitations

1. **Resource Isolation**: Coding tasks execute where the selected executor runs; container mode does not provide per-task Docker sandbox isolation, and host mode directly accesses the host environment
2. **Security**: Use in trusted environments; do not execute untrusted code
3. **Capability Scope**: Wework coding tasks and terminal are supported by default; IDE/code-server is not a default standalone capability

## Migrating from Standalone to Standard Mode

If you need to migrate to standard mode:

1. Export SQLite data
2. Back up projects and worktrees under `/workspace`
3. Import data into MySQL
4. Update configuration to use standard deployment or separate cloud devices
