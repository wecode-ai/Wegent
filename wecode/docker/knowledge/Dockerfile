# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/python:3.12-slim

# Set working directory
WORKDIR /app

# Configure Aliyun Debian mirror and install system dependencies:
# - tzdata: timezone configuration
# - libmagic1: required by python-magic
# - tesseract-ocr: required by pytesseract
# - poppler-utils: required by pdf2image
RUN sed -i 's|http://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y \
    tzdata libmagic1 tesseract-ocr poppler-utils && \
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

# Copy and install knowledge_engine module
COPY knowledge_engine /app/knowledge_engine
RUN uv pip install --system --no-cache /app/knowledge_engine

# Copy pyproject.toml and install dependencies
# Remove [tool.uv.sources] section after local workspace packages are installed
COPY knowledge_runtime/pyproject.toml .

# Wait up to 10 minutes for active streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600
# Reject new requests during shutdown with 503 Service Unavailable
ENV SHUTDOWN_REJECT_NEW_REQUESTS=true

# LOG
ENV LOG_DIR="/data1/weibo/logs"
ENV LOG_FILE_ENABLED=true

RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY knowledge_runtime /app
# Also copy shared to /app/shared for PYTHONPATH imports
COPY shared /app/shared
COPY knowledge_engine /app/knowledge_engine

# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8200
# Expose port
EXPOSE ${PORT}

# Start command with graceful shutdown support
# --timeout-graceful-shutdown: Time to wait for active connections to close
# Using exec form to ensure proper signal handling (SIGTERM)
CMD ["sh", "-c", "exec uvicorn knowledge_runtime.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]