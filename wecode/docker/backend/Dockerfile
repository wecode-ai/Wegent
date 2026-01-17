# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/python:3.12-slim

# Set working directory
WORKDIR /app

# Configure Aliyun Debian mirror and install tzdata and libmagic (required by python-magic)
RUN sed -i 's|http://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y tzdata libmagic1 && \
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

# Copy and install chat_shell module
COPY chat_shell /app/chat_shell
RUN uv pip install --system --no-cache /app/chat_shell

# Copy pyproject.toml and install dependencies
# Remove [tool.uv.sources] section as shared is already installed
COPY backend/pyproject.toml .
ENV EXECUTOR_ENV='{"DEFAULT_HEADERS":{"wecode-source":"agent","wecode-user":"${task_data.user.name}","wecode-action":"wegent","wecode-executor":"chat"}}'

# OpenTelemetry configuration
ENV OTEL_ENABLED=true
ENV OTEL_MAX_BODY_SIZE=1048576
ENV OTEL_CAPTURE_REQUEST_HEADERS=true
ENV OTEL_CAPTURE_REQUEST_BODY=true
ENV OTEL_TRACES_SAMPLER_ARG=1.0
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://wegent-otel-web.wb-plat-ide.svc.cluster.local:4317

# Wait up to 10 minutes for active streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600
# Reject new requests during shutdown with 503 Service Unavailable
ENV SHUTDOWN_REJECT_NEW_REQUESTS=true

RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

RUN PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright playwright install chromium && playwright install-deps chromium

# Copy application code
COPY backend /app
# Also copy shared to /app/shared for PYTHONPATH imports
COPY shared /app/shared
COPY resource.yaml /app/init_data/new_user/resource.yaml
# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Expose port
EXPOSE ${PORT}

# Start command with graceful shutdown support
# --timeout-graceful-shutdown: Time to wait for active connections to close
# Using exec form to ensure proper signal handling (SIGTERM)
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]