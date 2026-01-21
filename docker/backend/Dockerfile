# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.2.1

# Set working directory
WORKDIR /app

# Copy local dependencies first (required for pyproject.toml)
# Paths must match pyproject.toml [tool.uv.sources] relative paths from /app:
# - wegent-chat-shell = { path = "../chat_shell" } -> /chat_shell
# - wegent-shared = { path = "../shared" } -> /shared
COPY chat_shell /chat_shell
COPY shared /shared

# Copy pyproject.toml and install dependencies
COPY backend/pyproject.toml .
RUN uv pip install --system --no-cache -r pyproject.toml

# Pre-cache tiktoken encoding files to avoid runtime network requests
# This prevents SSL errors when tiktoken tries to download encodings at runtime
ENV TIKTOKEN_CACHE_DIR=/app/.tiktoken_cache
RUN mkdir -p ${TIKTOKEN_CACHE_DIR} && \
    python -c "import tiktoken; tiktoken.get_encoding('cl100k_base'); tiktoken.get_encoding('gpt2')"

# Copy application code
COPY backend /app
# Also copy shared to /app/shared for PYTHONPATH imports
COPY shared /app/shared

# Copy init_data directory with default resources and skills into the image
# This includes:
# - 01-default-resources.yaml: Default Ghost, Model, Shell, Bot, Team resources
# - 02-public-shells.yaml: Public shell configurations
# - skills/: Skill packages (mermaid-diagram, wiki_submit, subagent)
COPY backend/init_data /app/init_data

# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Default: 600 seconds (10 minutes) for long-running streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600
# Expose port
EXPOSE ${PORT}

# Start command with graceful shutdown support
# --timeout-graceful-shutdown: Time to wait for active connections to close
# Using exec form to ensure proper signal handling (SIGTERM)
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 4 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]