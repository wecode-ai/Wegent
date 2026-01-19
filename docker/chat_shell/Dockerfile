# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

# Set working directory
WORKDIR /app

# Copy and install shared module first
COPY shared /app/shared
RUN uv pip install --system --no-cache /app/shared

# Copy pyproject.toml and install dependencies
# Remove [tool.uv.sources] section as shared is already installed
COPY chat_shell/pyproject.toml .
RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY chat_shell/chat_shell /app/chat_shell

# Environment variables
ENV CHAT_SHELL_MODE="http"
ENV CHAT_SHELL_STORAGE_TYPE="remote"
ENV CHAT_SHELL_REMOTE_STORAGE_URL="http://backend:8000/api/internal"

# Server configuration
ENV PORT=8100
ENV HOST=0.0.0.0
# Default: 600 seconds (10 minutes) for long-running streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600

# Expose port
EXPOSE ${PORT}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Start command with graceful shutdown support
CMD ["sh", "-c", "exec uvicorn chat_shell.main:app --host ${HOST} --port ${PORT} --workers 4 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]
