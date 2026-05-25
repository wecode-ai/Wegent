# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# docker/knowledge_doc_converter/Dockerfile
# Celery worker for document conversion (PDF/PPTX/etc. to Markdown)
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /app

# Copy and install shared module first
COPY shared /app/shared
RUN uv pip install --system --no-cache /app/shared

# Copy and install knowledge_engine module (provides conversion logic)
COPY knowledge_engine /app/knowledge_engine
RUN uv pip install --system --no-cache /app/knowledge_engine

# Copy pyproject.toml and install dependencies
# Remove [tool.uv.sources] section as dependencies are already installed
COPY knowledge_doc_converter/pyproject.toml .
RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY knowledge_doc_converter/knowledge_doc_converter /app/knowledge_doc_converter

# Create log directory
RUN mkdir -p /app/logs

# PYTHONPATH includes shared/ and knowledge_engine/ for runtime imports
ENV PYTHONPATH=/app

# Logging configuration
ENV LOG_FILE_ENABLED=true
ENV LOG_DIR=/app/logs
ENV LOG_LEVEL=INFO

# Worker configuration
ENV CELERY_QUEUE=knowledge_conversion
ENV CELERY_CONCURRENCY=2
ENV CELERY_LOGLEVEL=info

# Prometheus metrics (disabled by default)
ENV PROMETHEUS_ENABLED=false
ENV PROMETHEUS_PORT=9090
ENV PROMETHEUS_PATH=/metrics
EXPOSE ${PROMETHEUS_PORT}

# Start Celery worker consuming the knowledge_conversion queue
CMD ["sh", "-c", "exec celery -A knowledge_doc_converter.celery_app worker \
    --queues=${CELERY_QUEUE} \
    --concurrency=${CELERY_CONCURRENCY} \
    --loglevel=${CELERY_LOGLEVEL}"]
