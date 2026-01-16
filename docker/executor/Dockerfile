# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS builder

WORKDIR /app

# Copy pyproject.toml and install dependencies
COPY executor/pyproject.toml /app/executor/pyproject.toml

RUN cd /app/executor && uv pip install --system --no-cache -r pyproject.toml

# Copy source code
COPY executor /app/executor
COPY shared /app/shared

# Build standalone binary
RUN cd /app/executor && bash build.sh

# Runtime stage: minimal image with only the binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /app

# Copy only the standalone binary from builder
COPY --from=builder /app/executor/dist/executor /app/executor

ENV PORT=10001
ENV PYTHONPATH=/app

# Run the standalone binary
CMD ["/app/executor"]
