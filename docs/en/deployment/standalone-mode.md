---
sidebar_position: 3
---

# Standalone Mode Deployment

## Overview

Standalone mode is a single-machine deployment solution that packages Backend, Frontend, Chat Shell, Executor, and Redis into a single Docker image, using SQLite for the database. No external dependencies required - just Docker.

### Use Cases

- Single-machine deployment
- Development and testing
- Small-scale usage
- Quick evaluation

### Architecture Comparison

| Feature | Standard Mode | Standalone Mode |
|---------|---------------|-----------------|
| Deployment Complexity | High (multi-container) | Low (single container) |
| Resource Usage | High | Medium |
| Scalability | Good | Limited |
| Isolation | Good (Docker) | None |
| Database | MySQL | SQLite |
| Redis | External | Embedded |
| Use Case | Production | Dev/Test/Small-scale |

## Quick Start

### One Command Installation (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

This will automatically:
1. Check and install Docker if needed
2. Pull the latest Wegent standalone image
3. Create a data volume for persistence
4. Start the container

### Running Container Directly

If you prefer to run the container manually:

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

For remote access (replace `YOUR_SERVER_IP` with your actual IP):

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  -e RUNTIME_SOCKET_DIRECT_URL=http://YOUR_SERVER_IP:8000 \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RUNTIME_SOCKET_DIRECT_URL` | WebSocket URL for frontend | `http://localhost:8000` |
| `STANDALONE_MODE` | Enable standalone mode | `true` |
| `DATABASE_URL` | Database connection URL | `sqlite:////app/data/wegent.db` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379/0` |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |

### Data Persistence

Data is stored in the `/app/data` directory, including:
- `wegent.db` - SQLite database file
- `redis/` - Redis persistence data (AOF and RDB)
- Other runtime data

Use Docker volume for persistence:

```bash
# Create a named volume
docker volume create wegent-data

# Run with the volume
docker run -v wegent-data:/app/data ...
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

# Remove the container (data is preserved in volume)
docker rm -f wegent-standalone

# Update to latest version
docker pull ghcr.io/wecode-ai/wegent-standalone:latest
docker rm -f wegent-standalone
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## Building the Image

If you need to build the image yourself:

```bash
# Use the build script
./scripts/build-standalone.sh

# Or specify a tag
./scripts/build-standalone.sh -t my-registry/wegent:v1.0

# Specify platform
./scripts/build-standalone.sh -p linux/amd64
```

## Important Notes

### SQLite Limitations

1. **Concurrent Writes**: SQLite doesn't support high-concurrency writes, suitable for single-user or small-scale usage
2. **Data Backup**: Regularly backup the `/app/data/wegent.db` file

### Embedded Redis

The standalone image includes an embedded Redis server:
- Data is persisted to `/app/data/redis/`
- Uses AOF (Append Only File) for durability
- Memory limit: 256MB with LRU eviction policy

### In-Process Executor Limitations

1. **Resource Isolation**: No Docker container isolation, tasks share process resources
2. **Security**: Code execution has no sandbox protection
3. **Use Case**: Only suitable for trusted environments and development/testing

## Migrating from Standalone to Standard Mode

If you need to migrate to standard mode:

1. Export SQLite data
2. Import to MySQL
3. Modify configuration for standard deployment

For detailed migration guide, see [Data Migration Documentation](./data-migration.md).
