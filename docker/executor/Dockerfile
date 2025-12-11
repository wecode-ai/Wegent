# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.1 AS builder

WORKDIR /app

# Install latest Claude Code CLI (requires version >= 2.0.0 for Agent SDK compatibility)
RUN npm install -g @anthropic-ai/claude-code@latest

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    export PATH="/root/.local/bin:${PATH}" && \
    uv --version

ENV PATH="/root/.local/bin:${PATH}"

# Copy pyproject.toml and install dependencies
COPY executor/pyproject.toml /app/executor/pyproject.toml

RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz

ENV PATH="/usr/local/bin:${PATH}"
RUN yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6 && \
    cd /app/executor && uv pip install --system --no-cache -r pyproject.toml

# Copy source code
COPY executor /app/executor
COPY shared /app/shared

# Build standalone binary
RUN cd /app/executor && bash build.sh

# Runtime stage: minimal image with only the binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.1

WORKDIR /app

# Install latest Claude Code CLI (requires version >= 2.0.0 for Agent SDK compatibility)
RUN npm install -g @anthropic-ai/claude-code@latest

# Install uv in runtime stage
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    export PATH="/root/.local/bin:${PATH}" && \
    uv --version

ENV PATH="/root/.local/bin:${PATH}"

# Install sqlite
RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz

ENV PATH="/usr/local/bin:${PATH}"
RUN yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6

# Copy only the standalone binary from builder
COPY --from=builder /app/executor/dist/executor /app/executor

ENV PORT=10001
ENV PYTHONPATH=/app

# Run the standalone binary
CMD ["/app/executor"]
