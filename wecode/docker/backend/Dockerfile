# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

ARG PYTHON_BASE_IMAGE=registry.api.weibo.com/wecode/python:3.12-slim
ARG RUST_BASE_IMAGE=registry.api.weibo.com/weibo_rd_if/rust-builder:1.98.1

FROM ${RUST_BASE_IMAGE} AS rust-builder

WORKDIR /build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates libssl-dev pkg-config && \
    mkdir -p /root/.cargo && \
    printf '%s\n' \
      '[source.crates-io]' \
      'replace-with = "rsproxy-sparse"' \
      '' \
      '[source.rsproxy-sparse]' \
      'registry = "sparse+https://rsproxy.cn/index/"' \
      '' \
      '[net]' \
      'git-fetch-with-cli = true' \
      > /root/.cargo/config.toml && \
    rm -rf /var/lib/apt/lists/*

COPY backend-rs /build/backend-rs
COPY backend-rs-intra /build/backend-rs-intra

RUN cargo build \
    --release \
    --locked \
    --manifest-path /build/backend-rs-intra/Cargo.toml \
    --bin wegent-backend-rs

FROM ${PYTHON_BASE_IMAGE}

# Set working directory
WORKDIR /app

# Configure Aliyun Debian mirror and install system dependencies:
# - tzdata: timezone configuration
# - libmagic1: required by python-magic
# - tesseract-ocr: required by pytesseract
# - poppler-utils: required by pdf2image
# - Playwright chromium dependencies (for Debian Trixie, manually install as playwright install-deps uses obsolete package names)
RUN sed -i 's|http://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y \
    bash tzdata libmagic1 tesseract-ocr poppler-utils \
    libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
    libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    fonts-unifont fonts-liberation fonts-noto-color-emoji && \
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

# Copy and install chat_shell module
COPY chat_shell /app/chat_shell
RUN uv pip install --system --no-cache /app/chat_shell

# Copy and install knowledge_engine module
COPY knowledge_engine /app/knowledge_engine
RUN uv pip install --system --no-cache /app/knowledge_engine

# Copy pyproject.toml and install dependencies
# Remove [tool.uv.sources] section after local workspace packages are installed
COPY backend/pyproject.toml .
ENV EXECUTOR_ENV='{"DEFAULT_HEADERS":{"wecode-source":"agent","wecode-user":"${task_data.user.name}","wecode-action":"wegent","wecode-executor":"chat","wecode-wegent-agent-namespace":"${task_data.team.namespace}","wecode-wegent-agent-name":"${task_data.team.name}"}}'

# OpenTelemetry configuration
ENV OTEL_ENABLED=true
ENV OTEL_MAX_BODY_SIZE=1048576
ENV OTEL_CAPTURE_REQUEST_HEADERS=true
ENV OTEL_CAPTURE_REQUEST_BODY=true
ENV OTEL_TRACES_SAMPLER_ARG=1.0
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://wegent-otel-web.wb-plat-ide.svc.cluster.local:4317

ENV USER_AES_KEY="base64:kKkJG0DFp9s/NgzSF99CSPLxXQ9LoRdi8FQ0mwQSuf4="

# WEIBO MCP
ENV WEIBO_MCP_SYSTEM_TOKEN="mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NjczODA4NywibyI6IjUzMDU4MDY2MCJ9.p7x2xZacfNQblxTroVihnwdoIxeClaIOXCxg7paONc0"
ENV WEIBO_SKILL_MARKET_TOKEN="mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NjczODA4NywibyI6IjUzMDU4MDY2MCJ9.p7x2xZacfNQblxTroVihnwdoIxeClaIOXCxg7paONc0"

# Wait up to 10 minutes for active streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600
# Reject new requests during shutdown with 503 Service Unavailable
ENV SHUTDOWN_REJECT_NEW_REQUESTS=true

# LOG
ENV LOG_DIR="/data1/weibo/logs"
ENV LOG_FILE_ENABLED=true
ENV BREEZE_LOG_DIR="${LOG_DIR}/rust"
ENV BREEZE_PROFILE_LOG_PATH="${BREEZE_LOG_DIR}/profile.log"

RUN sed -i '/\[tool\.uv\.sources\]/,/^$/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

# Install Playwright chromium browser from npmmirror
# Playwright version is pinned in pyproject.toml to ensure mirror compatibility
# Dependencies are already installed above (playwright install-deps uses obsolete package names on Debian Trixie)
RUN PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright playwright install chromium

# Copy application code
COPY backend /app
# Also copy shared to /app/shared for PYTHONPATH imports
COPY shared /app/shared
# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

COPY --from=rust-builder \
    /build/backend-rs-intra/target/release/wegent-backend-rs \
    /usr/local/bin/wegent-backend-rs
COPY backend-rs-intra/config /app/backend-rs-intra/config
RUN rm /app/backend-rs-intra/config/routes-public.toml
# Keep the public cutovers beside the intra entry file; its include is local.
COPY backend-rs/config/routes.toml /app/backend-rs-intra/config/routes-public.toml
COPY start-hybrid-backend.sh /usr/local/bin/start-hybrid-backend

RUN mkdir -p "$LOG_DIR" "$BREEZE_LOG_DIR" && \
    chmod 0755 /usr/local/bin/start-hybrid-backend && \
    ldd /usr/local/bin/wegent-backend-rs && \
    ! ldd /usr/local/bin/wegent-backend-rs | grep -q 'not found'

ENV PORT=8000
ENV WEGENT_ENV_FILE=/app/.env
ENV WEGENT_PYTHON_UPSTREAM_PORT=8004
ENV WEGENT_RS_ROUTES_FILE=/app/backend-rs-intra/config/routes.toml
ENV AIGC_VIDEO_AGENT_URL=http://i.aigc-intra.multimedia.api.weibo.com
# Expose port
EXPOSE ${PORT}

CMD ["/usr/local/bin/start-hybrid-backend"]
