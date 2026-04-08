# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.2.1

# Set working directory
WORKDIR /app

# Copy and install local workspace dependencies first so backend can be
# installed without relying on an external package registry.
COPY shared /app/shared
RUN uv pip install --system --no-cache /app/shared

COPY chat_shell /app/chat_shell
RUN uv pip install --system --no-cache /app/chat_shell

COPY knowledge_engine /app/knowledge_engine
RUN uv pip install --system --no-cache /app/knowledge_engine

# Copy pyproject.toml and install dependencies
COPY backend/pyproject.toml .
RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY backend /app
# Also copy shared to /app/shared for PYTHONPATH imports
COPY shared /app/shared

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

# Start command with graceful shutdown support
# --timeout-graceful-shutdown: Time to wait for active connections to close
# Using exec form to ensure proper signal handling (SIGTERM)
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]
