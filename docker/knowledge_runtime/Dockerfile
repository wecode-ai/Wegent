# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.2.1

WORKDIR /app

# Copy local dependencies first so uv can resolve path sources.
COPY shared /shared
COPY knowledge_engine /knowledge_engine

# Copy pyproject.toml and install dependencies.
COPY knowledge_runtime/pyproject.toml .
RUN uv pip install --system --no-cache -r pyproject.toml

# Copy application code.
COPY knowledge_runtime /app

ENV PORT=8200
ENV HOST=0.0.0.0
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["sh", "-c", "exec uvicorn knowledge_runtime.main:app --host ${HOST} --port ${PORT} --workers 1 --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT}"]
