---
sidebar_position: 3
---

# Standalone Mode Deployment

## Overview

Standalone mode is a single-machine deployment that packages Backend, the main Frontend, Wework Web, Chat Shell, Executor, ttyd, and Redis into one Docker image, using SQLite as the database. It is intended for quick evaluation and small trusted environments, and only requires Docker.

After startup, standalone automatically creates a cloud device for the `admin` user: the in-container executor registers through the Backend device WebSocket, and Wework can use that device directly for coding tasks. The default workspace is mounted at `/workspace` and stores project directories, standalone chat workspaces, and Git worktrees.

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
| Task Isolation | Sandbox/cloud device | Same standalone container |
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
4. Publish ports for the main frontend, Wework, Backend, terminal, and session gateway
5. Start the container and wait for Backend, Wework, and terminal readiness

After startup, open:

| Entry | URL | Purpose |
|-------|-----|---------|
| Main Frontend | `http://localhost:3000` | Wegent management and general features |
| Wework | `http://localhost:3001` | Create and use coding tasks |
| Backend API | `http://localhost:8000` | API and WebSocket |
| Terminal | `http://localhost:7681` | General terminal rooted at `/workspace` |
| Session Gateway | `http://localhost:17888` | Used by Wework project terminals; you do not open it directly |

### Running Container Directly

For local access:

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 3001:3001 \
  -p 8000:8000 \
  -p 7681:7681 \
  -p 17888:17888 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000 \
  -e WEWORK_PUBLIC_BACKEND_URL=http://localhost:8000 \
  -e DEVICE_PUBLIC_BASE_URL=http://localhost:17888 \
  -e TTYD_CREDENTIALS=admin:CHANGE_ME \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

For remote access, replace `YOUR_SERVER_IP` with your server IP or domain:

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 3001:3001 \
  -p 8000:8000 \
  -p 7681:7681 \
  -p 17888:17888 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://YOUR_SERVER_IP:8000 \
  -e WEWORK_PUBLIC_BACKEND_URL=http://YOUR_SERVER_IP:8000 \
  -e DEVICE_PUBLIC_BASE_URL=http://YOUR_SERVER_IP:17888 \
  -e TTYD_CREDENTIALS=admin:CHANGE_ME \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

`WEWORK_PUBLIC_BACKEND_URL` is written into Wework's `runtime-config.js` during container startup, so a browser opening `http://YOUR_SERVER_IP:3001` connects to the server Backend instead of the user's local `localhost`.

## Using Wework for Coding Tasks

1. Open `http://localhost:3001` (use the server address for remote deployments).
2. Sign in with the initialized account, or follow the page prompts to finish account setup.
3. Configure an available model and provider token in settings.
4. Return to the Wework workbench and send a coding request directly.
5. If no project is selected, Wework routes the request to the automatically registered standalone cloud device and creates a standalone chat workspace under `/workspace/chats`.
6. After creating a Git project, new tasks use project and task workspaces under `/workspace/projects` and `/workspace/worktrees`.
7. To inspect files or open a terminal, use the Wework project toolbar. The general ttyd terminal uses `TTYD_CREDENTIALS` for login, and project terminals are served through the device session gateway with short-lived access URLs.

Standalone does not include the IDE/code-server entry by default. For the first standalone launch, treat Wework coding, workspace files, and project terminal as the primary capabilities. Use standard deployment or a separate cloud device when you need IDE access or stronger isolation.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RUNTIME_SOCKET_DIRECT_URL` | Backend WebSocket URL used by the main Frontend | `http://localhost:8000` |
| `WEWORK_PUBLIC_BACKEND_URL` | Runtime Backend URL for Wework Web; derives API and Socket URLs | `http://localhost:8000` |
| `WEWORK_PUBLIC_API_URL` | Wework Web API URL; overrides `WEWORK_PUBLIC_BACKEND_URL/api` | `${WEWORK_PUBLIC_BACKEND_URL}/api` |
| `WEWORK_PUBLIC_SOCKET_URL` | Wework Web Socket.IO URL; overrides `WEWORK_PUBLIC_BACKEND_URL` | `${WEWORK_PUBLIC_BACKEND_URL}` |
| `DEVICE_PUBLIC_BASE_URL` | Browser-facing URL for the device session gateway | `http://localhost:17888` |
| `WEGENT_WORKSPACE_ROOT` | Standalone workspace root | `/workspace` |
| `WEWORK_PORT` | Wework Web container port | `3001` |
| `TTYD_PORT` | General ttyd terminal container port | `7681` |
| `TTYD_CREDENTIALS` | General ttyd terminal credentials in `user:password` format | Required |
| `DEVICE_SESSION_GATEWAY_PORT` | Project terminal session gateway container port | `17888` |
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
- `standalone-executor/`: executor local state

Workspace data is stored in `/workspace`:

- `projects/`: Wework Git project directories
- `chats/`: standalone chat workspaces without a selected project
- `worktrees/`: per-task Git worktrees

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
  -p 3001:3001 \
  -p 8000:8000 \
  -p 7681:7681 \
  -p 17888:17888 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000 \
  -e WEWORK_PUBLIC_BACKEND_URL=http://localhost:8000 \
  -e DEVICE_PUBLIC_BASE_URL=http://localhost:17888 \
  -e TTYD_CREDENTIALS=admin:CHANGE_ME \
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

1. **Resource Isolation**: Coding tasks execute in the same standalone container and do not get per-task Docker sandbox isolation
2. **Security**: Use in trusted environments; do not execute untrusted code
3. **Capability Scope**: Wework coding tasks and terminal are supported by default; IDE/code-server is not a default standalone capability

## Migrating from Standalone to Standard Mode

If you need to migrate to standard mode:

1. Export SQLite data
2. Back up projects and worktrees under `/workspace`
3. Import data into MySQL
4. Update configuration to use standard deployment or separate cloud devices
