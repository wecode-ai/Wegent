# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

# Set working directory
WORKDIR /app

# Copy and install shared module first
COPY shared /app/shared
RUN uv pip install --system --no-cache /app/shared

# Copy and install knowledge_engine module
COPY knowledge_engine /app/knowledge_engine
RUN uv pip install --system --no-cache /app/knowledge_engine

# Copy pyproject.toml and install dependencies
# Remove [tool.uv.sources] section as dependencies are already installed
COPY knowledge_runtime/pyproject.toml .
RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY knowledge_runtime/knowledge_runtime /app/knowledge_runtime

# Environment variables
ENV PORT=8200
ENV HOST=0.0.0.0

# Create log directory
RUN mkdir -p /app/logs

# Expose port
EXPOSE ${PORT}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/internal/rag/health || exit 1

# Start command
CMD ["sh", "-c", "exec uvicorn knowledge_runtime.main:app --host ${HOST} --port ${PORT}"]