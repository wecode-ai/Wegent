# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# docker/conversion/Dockerfile
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /app

# Copy workspace dependencies (backend references them via relative paths)
COPY shared /app/shared
RUN uv pip install --system --no-cache /app/shared

COPY knowledge_engine /app/knowledge_engine
RUN uv pip install --system --no-cache /app/knowledge_engine

COPY chat_shell /app/chat_shell
RUN uv pip install --system --no-cache /app/chat_shell

# Install backend dependencies
COPY backend/pyproject.toml /app/backend/pyproject.toml
RUN cd /app/backend && uv pip install --system --no-cache -r pyproject.toml

# Copy backend application code
COPY backend /app

# Create .env if missing
RUN if [ ! -f .env ]; then cp .env.example .env; fi

# Worker configuration
ENV CELERY_QUEUE=knowledge_conversion
ENV CELERY_CONCURRENCY=2
ENV CELERY_LOGLEVEL=info
ENV CELERY_HOSTNAME=conversion-worker@%h

# Start Celery worker
CMD ["sh", "-c", "exec celery -A app.core.celery_app worker \
    --queues=${CELERY_QUEUE} \
    --concurrency=${CELERY_CONCURRENCY} \
    --hostname=${CELERY_HOSTNAME} \
    --loglevel=${CELERY_LOGLEVEL}"]
