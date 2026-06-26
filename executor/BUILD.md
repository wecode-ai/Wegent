# Executor Rust Binary

## Overview

The executor is built as a Rust binary named `wegent-executor`. Docker mode runs
the HTTP executor server directly from this binary, while local mode starts the
desktop app IPC sidecar and, when `WEGENT_BACKEND_URL` is configured, the
Socket.IO local backend runner.

## Local Build

```bash
cargo build --release --locked
```

The binary is produced at:

```bash
target/release/wegent-executor
```

## Docker Image

The executor image uses `docker/executor/Dockerfile`.

```bash
docker build -f docker/executor/Dockerfile -t executor:latest .
```

The runtime image copies only the Rust binary to `/app/executor`, matching the
stable path used by executor manager binary extraction and custom base image
mounts:

```bash
docker run -p 10001:10001 -e EXECUTOR_MODE=docker -e PORT=10001 executor:latest
```

The image still installs Claude Code, OpenAI Codex CLI, browser automation, and
document-generation dependencies used by existing executor skills.
