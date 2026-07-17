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
COPY knowledge_doc_converter/pyproject.toml .

# Logging configuration
ENV LOG_FILE_ENABLED=true
ENV LOG_DIR=/data1/weibo/logs
ENV LOG_LEVEL=INFO

# Worker configuration
ENV KNOWLEDGE_CONVERSION_QUEUE=knowledge_conversion
ENV MULTIMODAL_QUEUE=knowledge_multimodal_conversion
ENV CELERY_CONCURRENCY=2
ENV CELERY_LOGLEVEL=info
ENV CELERY_QUEUE=knowledge_conversion,knowledge_multimodal_conversion

# Prometheus metrics (disabled by default)
ENV PROMETHEUS_ENABLED=true
ENV PROMETHEUS_PORT=9090
ENV PROMETHEUS_PATH=/metrics
EXPOSE ${PROMETHEUS_PORT}

RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY knowledge_doc_converter /app

# PYTHONPATH includes shared/ and knowledge_engine/ for runtime imports

RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=9090

# Expose port
EXPOSE ${PORT}

# Start Celery worker consuming the knowledge_conversion queue
CMD ["sh", "-c", "exec celery -A knowledge_doc_converter.celery_app worker \
    --queues=${CELERY_QUEUE} \
    --concurrency=${CELERY_CONCURRENCY} \
    --loglevel=${CELERY_LOGLEVEL}"]
