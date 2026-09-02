# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

# Set working directory
WORKDIR /app

# Copy local workspace dependencies so backend can resolve them via
# `pyproject.toml` [tool.uv.sources] relative paths from /app/backend:
# - wegent-shared = { path = "../shared" } -> /app/shared
# - wegent-chat-shell = { path = "../chat_shell" } -> /app/chat_shell
# - wegent-knowledge-engine = { path = "../knowledge_engine" } -> /app/knowledge_engine
COPY shared /app/shared
COPY chat_shell /app/chat_shell
COPY knowledge_engine /app/knowledge_engine

# Copy pyproject.toml and install dependencies
COPY backend/pyproject.toml /app/backend/pyproject.toml
RUN cd /app/backend && uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY backend /app

# Copy init_data directory with default resources and skills into the image
# This includes:
# - 01-default-resources.yaml: Default Ghost, Model, Shell, Bot, Team resources
# - 02-public-shells.yaml: Public shell configurations
# - skills/: Skill packages (mermaid-diagram, wiki_submit, sandbox)
COPY backend/init_data /app/init_data

# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Default: 600 seconds (10 minutes) for long-running streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600
# Expose port
EXPOSE ${PORT}

# The runtime supervisor owns graceful shutdown for every child role.
STOPSIGNAL SIGTERM

# Readiness includes the database and a real round trip to the sibling stream worker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/api/ready || exit 1

# Start one supervisor that owns heterogeneous Web and stream worker processes.
CMD ["python", "-m", "app.runtime"]
