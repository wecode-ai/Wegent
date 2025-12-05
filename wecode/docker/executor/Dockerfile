# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go AS builder

WORKDIR /app

# Configure npm registry for China
RUN npm config set registry https://registry.npmmirror.com

RUN npm update -g @anthropic-ai/claude-code

# Install uv from PyPI using Aliyun mirror
RUN pip install --no-cache-dir uv -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com && \
    uv --version

# Configure uv to use Aliyun PyPI mirror
ENV UV_INDEX_URL="http://mirrors.cloud.aliyuncs.com/pypi/simple/"
ENV UV_EXTRA_INDEX_URL=""

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
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go

WORKDIR /app
# Configure npm registry for China
RUN npm config set registry https://registry.npmmirror.com

RUN npm update -g @anthropic-ai/claude-code

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

# Set claude code environment variables
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY="false"

# Copy only the standalone binary from builder
COPY --from=builder /app/executor/dist/executor /app/executor

# Copy WeCode specific config files
COPY claude_hooks.json /app/config/claude_hooks.json

ENV PORT=10001
ENV PYTHONPATH=/app
ENV CUSTOM_CONFIG='{"wecode_config": "executor.wecode.config.config.WeCodeConfig"}'

# Run the standalone binary
CMD ["/app/executor"]
CMD ["/app/executor"]

