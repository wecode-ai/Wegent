# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest
WORKDIR /app/executor_manager

# Copy shared module first (required for local dependency)
COPY shared /app/shared

# Copy pyproject.toml and install dependencies
COPY executor_manager/pyproject.toml /app/executor_manager/pyproject.toml
RUN cd /app/executor_manager && uv pip install --system --no-cache -r pyproject.toml

ENV PYTHONPATH=/app
COPY executor_manager /app/executor_manager

ENV PORT=9081
ENTRYPOINT ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-9081}"]