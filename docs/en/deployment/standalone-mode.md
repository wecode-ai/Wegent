---
sidebar_position: 3
---

# Standalone Mode Deployment

## Overview

Standalone mode is a single-machine deployment solution that packages Backend, Frontend, Chat Shell, and Executor into a single Docker image, using SQLite instead of MySQL, with Redis as an external dependency.

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
| Use Case | Production | Dev/Test/Small-scale |

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Clone the repository
git clone https://github.com/wecode-ai/wegent.git
cd wegent

# Start services
docker-compose -f docker-compose.standalone.yml up -d

# View logs
docker-compose -f docker-compose.standalone.yml logs -f
```

### Running Container Directly

If you already have a Redis service:

```bash
docker run -d \
  --name wegent \
  -p 3000:3000 \
  -p 8000:8000 \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -v wegent-data:/app/data \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | `redis://redis:6379/0` |
| `STANDALONE_MODE` | Enable standalone mode | `true` |
| `DATABASE_URL` | Database connection URL | `sqlite:///./data/wegent.db` |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |

### Data Persistence

Data is stored in the `/app/data` directory, including:
- `wegent.db` - SQLite database file
- Other runtime data

Use Docker volume for persistence:

```bash
docker run -v wegent-data:/app/data ...
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

### In-Process Executor Limitations

1. **Resource Isolation**: No Docker container isolation, tasks share process resources
2. **Security**: Code execution has no sandbox protection
3. **Use Case**: Only suitable for trusted environments and development/testing

### Redis Dependency

Standalone mode still requires Redis for:
- Distributed locks
- Session management
- Task queues
- Caching

## Migrating from Standalone to Standard Mode

If you need to migrate to standard mode:

1. Export SQLite data
2. Import to MySQL
3. Modify configuration for standard deployment

For detailed migration guide, see [Data Migration Documentation](./data-migration.md).
