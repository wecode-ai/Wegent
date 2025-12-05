# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/python:3.12-slim

# Set working directory
WORKDIR /app

# Configure Aliyun Debian mirror and install tzdata
RUN sed -i 's|http://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y tzdata && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    export PATH="/root/.local/bin:${PATH}" && \
    uv --version

ENV PATH="/root/.local/bin:${PATH}"

# Copy pyproject.toml and install dependencies
COPY backend/pyproject.toml .
ENV EXECUTOR_ENV='{"DEFAULT_HEADERS":{"wecode-source":"agent","wecode-user":"${task_data.user.name}","wecode-action":"wegent","wecode-executor":"agno"}}'
RUN uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY backend /app
COPY shared /app/shared
COPY resource.json /app/resource.json
# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Expose port
EXPOSE ${PORT}


# Start command
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 4"]