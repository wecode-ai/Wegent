# Executor Standalone Binary

## Overview

This directory contains the configuration to build the executor as a standalone binary using PyInstaller. The binary is self-contained and does not depend on the host machine's Python environment.

## Build Process

The build process uses a multi-stage Docker build:

1. **Builder Stage**: Compiles the Python code into a standalone binary
   - Installs all dependencies
   - Runs PyInstaller to create the binary
   - Binary is located at `/app/executor/dist/executor`

2. **Runtime Stage**: Creates a minimal image with only the binary
   - Copies the standalone binary from the builder stage
   - No Python dependencies needed at runtime
   - Significantly smaller image size

## Files

- `executor.spec`: PyInstaller configuration file
- `build.sh`: Script to build the standalone binary
- `docker/executor/Dockerfile`: Multi-stage Dockerfile

## Building

To build the Docker image:

```bash
docker build -f docker/executor/Dockerfile -t executor:latest .
```

## Running

The binary runs the FastAPI server on the port specified by the `PORT` environment variable (default: 10001):

```bash
docker run -p 10001:10001 -e PORT=10001 executor:latest
```

## Benefits

1. **No Runtime Dependencies**: The binary is self-contained
2. **Faster Startup**: No need to load Python interpreter and modules
3. **Smaller Image**: Only includes the necessary code
4. **Better Security**: Reduced attack surface
