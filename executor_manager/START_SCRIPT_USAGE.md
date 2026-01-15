# Executor Manager One-Click Startup Script Usage Guide

## Quick Start

The simplest way to start (using default configuration):

```bash
cd executor_manager
./start.sh
```

## Custom Configuration

### Change Port

```bash
./start.sh --port 8002
```

### Change Executor Image

```bash
./start.sh --executor-image ghcr.io/wecode-ai/wegent-executor:latest
```

### Change Backend API Domain

```bash
./start.sh --task-api-domain http://backend:8000
```

### Multiple Custom Options

```bash
./start.sh --port 8002 --executor-image custom:latest --task-api-domain http://localhost:8000
```

## View Help Information

```bash
./start.sh --help
```

Output example:
```
Usage: ./start.sh [OPTIONS]

Options:
  --port PORT              Executor Manager port (default: 8001)
  --host HOST              Executor Manager host (default: 0.0.0.0)
  --executor-image IMAGE   Executor Docker image (default: ghcr.io/wecode-ai/wegent-executor:latest)
  --task-api-domain URL    Backend API domain (default: http://localhost:8000)
  -h, --help               Show this help message

Examples:
  ./start.sh                                    # Use default configuration
  ./start.sh --port 8002                        # Use custom port
  ./start.sh --executor-image custom:latest     # Use custom executor image
  ./start.sh --task-api-domain http://backend:8000  # Use custom backend URL
```

## Port Conflict Handling

If a port is already in use, the script provides friendly error messages:

```
Warning: Port 8001 (Executor Manager) is already in use

You have two options:
1. Stop the service using this port:
   lsof -i :8001  # Find the process
   kill -9 <PID>  # Stop the process

2. Use a different port (recommended):
   ./start.sh --port 8002
   ./start.sh --port 9001

For more options, run: ./start.sh --help
```

### Find Process Using Port

```bash
lsof -i :8001
```

### Stop Process Using Port

```bash
# After finding the PID
kill -9 <PID>
```

## Script Features

The startup script automatically completes the following steps:

1. ✓ Check Python version (requires 3.8+)
2. ✓ Check and install uv if needed
3. ✓ Sync dependencies with uv
4. ✓ Check Docker installation and status
5. ✓ Create Docker network if needed
6. ✓ Set PYTHONPATH
7. ✓ Detect Docker host IP address
8. ✓ Start Executor Manager server

## Port Validation

The script automatically validates port numbers:

- ✓ Port must be a number
- ✓ Port range: 1-65535
- ✓ Check if port is already in use

## Access Services

After successful startup, you can access:

- **Executor Manager**: http://localhost:8001
- **API Documentation**: http://localhost:8001/docs

## Prerequisites Check

### Docker Requirements

The script checks:
- Docker is installed
- Docker daemon is running
- Docker network exists (creates if needed)

If Docker is not running:
```
Error: Docker daemon is not running
Please start Docker and try again
```

### uv Installation

If uv is not installed, the script will automatically install it:
```
Warning: uv is not installed
Installing uv...
```

## FAQ

### Q: How to stop the service?

A: Press `Ctrl+C` to stop the service. The script will automatically clean up all processes.

**Important**: If you accidentally suspended the script (shows `suspended` status), you need to:

```bash
# Method 1: Bring to foreground and stop
fg              # Bring suspended job to foreground
Ctrl+C          # Then press Ctrl+C to stop

# Method 2: Kill all suspended jobs
jobs -p | xargs kill -9

# Method 3: Find and kill specific process
lsof -i :8001   # Find the PID
kill -9 <PID>   # Kill the process
```

### Q: What if I see "Port already in use" error?

A: This usually means:
1. A previous instance is still running (check with `lsof -i :8001`)
2. A suspended job exists (check with `jobs -l`)
3. Another service is using the port

The script will provide specific instructions based on the situation.

### Q: What if Docker is not installed?

A: The script will detect this and provide installation instructions:
```
Error: Docker is not installed
Executor Manager requires Docker to run executors
Please install Docker: https://docs.docker.com/get-docker/
```

### Q: What if Docker daemon is not running?

A: Start Docker Desktop (macOS/Windows) or Docker service (Linux):
```bash
# Linux
sudo systemctl start docker

# macOS/Windows
# Start Docker Desktop application
```

### Q: How to use a custom executor image?

A: Use the `--executor-image` parameter:
```bash
./start.sh --executor-image ghcr.io/wecode-ai/wegent-executor:latest
./start.sh --executor-image my-custom-executor:latest
```

### Q: How to connect to a remote backend?

A: Use the `--task-api-domain` parameter:
```bash
./start.sh --task-api-domain http://backend.example.com:8000
```

### Q: What is the Docker host address used for?

A: The Docker host address allows containers to communicate with services running on the host machine. The script automatically detects your host IP address.

## Technical Details

- **Dependency Management**: Uses uv for fast Python package management
- **PYTHONPATH**: Automatically set to project root directory for `shared` module access
- **Docker Network**: Creates `wegent-network` if it doesn't exist
- **Host IP Detection**: Automatically detects the host machine's IP address
- **Environment Variables**: Automatically exported for the application

## Example Scenarios

### Scenario 1: First Time Startup

```bash
cd executor_manager
./start.sh
```

The script will automatically install uv (if needed), sync dependencies, check Docker, and start the service.

### Scenario 2: Port 8001 is Occupied

```bash
./start.sh --port 8002
```

Start the service on a different port.

### Scenario 3: Using Custom Executor Image

```bash
./start.sh --executor-image ghcr.io/wecode-ai/wegent-executor:latest
```

Use a specific version of the executor image.

### Scenario 4: Development with Local Backend

```bash
./start.sh --task-api-domain http://localhost:8000
```

Connect to a backend running locally.

### Scenario 5: Production Setup

```bash
./start.sh --port 8001 --executor-image ghcr.io/wecode-ai/wegent-executor:latest --task-api-domain http://backend:8000
```

Full production configuration with specific image and backend URL.

## Environment Variables

The script automatically sets these environment variables:

- `EXECUTOR_IMAGE`: Docker image for executors
- `DOCKER_HOST_ADDR`: Host machine IP address
- `TASK_API_DOMAIN`: Backend API URL
- `PORT`: Executor Manager port
- `NETWORK`: Docker network name
- `PYTHONPATH`: Project root directory

## Troubleshooting

### Issue: "uv: command not found" after installation

**Solution**: Restart your terminal or run:
```bash
source ~/.cargo/env
```

### Issue: "Cannot connect to Docker daemon"

**Solution**: 
1. Check if Docker is running: `docker info`
2. Start Docker Desktop (macOS/Windows) or Docker service (Linux)
3. Check Docker socket permissions (Linux): `sudo chmod 666 /var/run/docker.sock`

### Issue: "Network wegent-network not found"

**Solution**: The script will automatically create it. If it fails, create manually:
```bash
docker network create wegent-network
```

### Issue: "Permission denied" when running script

**Solution**: Make the script executable:
```bash
chmod +x start.sh