# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go AS builder

WORKDIR /app

# Configure npm registry for China
RUN npm config set registry https://registry.npmmirror.com

RUN npm update -g @anthropic-ai/claude-code

# Copy requirements and install dependencies
COPY executor/requirements.txt /app/executor/requirements.txt

# Set environment variables
ENV PATH="/usr/local/bin:${PATH}"
# Configure pip with China mirror and increase timeout
RUN pip config set global.index-url http://mirrors.cloud.aliyuncs.com/pypi/simple/ && \
    pip config set global.trusted-host mirrors.cloud.aliyuncs.com && \
    pip config set global.timeout 300
RUN pip install -r /app/executor/requirements.txt

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

# Set claude code environment variables
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY="false"

# Copy only the standalone binary from builder
COPY --from=builder /app/executor/dist/executor /app/executor

# Copy WeCode specific files
COPY claude_hooks.json /app/config/claude_hooks.json
COPY file_change_sender.py /app/scripts/file_change_sender.py

ENV PORT=10001
ENV PYTHONPATH=/app
ENV CUSTOM_CONFIG='{"wecode_config": "executor.wecode.config.config.WeCodeConfig"}'

# Run the standalone binary
CMD ["/app/executor"]

