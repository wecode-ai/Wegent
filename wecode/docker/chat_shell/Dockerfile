# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/python:3.12-slim

# Set working directory
WORKDIR /app

# Configure Aliyun Debian mirror and install tzdata and curl for healthcheck
RUN sed -i 's|http://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y tzdata curl && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv from PyPI using Aliyun mirror
RUN pip install --no-cache-dir uv -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com && \
    uv --version

# Configure uv to use Aliyun PyPI mirror
ENV UV_INDEX_URL="http://mirrors.cloud.aliyuncs.com/pypi/simple/"
ENV UV_EXTRA_INDEX_URL=""

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

# Copy .env.example and create .env file (if it doesn't exist)
COPY chat_shell/.env.example /app/.env.example
RUN if [ ! -f .env ]; then cp .env.example .env; fi

# Environment variables for HTTP mode with remote storage
ENV CHAT_SHELL_MODE="http"
ENV CHAT_SHELL_STORAGE_TYPE="remote"
ENV CHAT_SHELL_REMOTE_STORAGE_URL="http://wegent-backend-web.wb-plat-ide.svc.cluster.local:8000/api/internal"

# OpenTelemetry configuration
ENV OTEL_ENABLED=true
ENV OTEL_MAX_BODY_SIZE=1048576
ENV OTEL_CAPTURE_REQUEST_HEADERS=true
ENV OTEL_CAPTURE_REQUEST_BODY=true
ENV OTEL_TRACES_SAMPLER_ARG=1.0
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://wegent-otel-web.wb-plat-ide.svc.cluster.local:4317

# Server configuration
ENV PORT=8100
ENV HOST=0.0.0.0
# Default: 600 seconds (10 minutes) for long-running streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600

ENV BACKEND_API_URL=http://wegent-backend-web.wb-plat-ide.svc.cluster.local:8000
ENV EXECUTOR_MANAGER_URL=http://wegent-executor-manager-web.wb-plat-ide.svc.cluster.local:8080
ENV E2B_API_KEY=kucvaN-qowmax-kyvni7

# LOG
ENV LOG_DIR="/data1/weibo/logs"
ENV LOG_FILE_ENABLED=true

# Expose port
EXPOSE ${PORT}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Start command with graceful shutdown support
CMD ["sh", "-c", "exec uvicorn chat_shell.main:app --host ${HOST} --port ${PORT} --workers 4 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]
