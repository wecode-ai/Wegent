# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build base stage: Rust toolchain and native build dependencies.
ARG BASE_IMAGE=registry.api.weibo.com/ci/wegent-runtime:0.0.2-fix-base-image

FROM ${BASE_IMAGE} AS builder-base
WORKDIR /app

ENV RUSTUP_DIST_SERVER=https://rsproxy.cn
ENV RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup

RUN dnf install -y gcc ca-certificates openssl-devel pkgconf-pkg-config \
    && curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh \
        | sh -s -- -y --profile minimal --default-toolchain stable \
    && mkdir -p /root/.cargo \
    && printf '%s\n' \
        '[source.crates-io]' \
        'replace-with = "rsproxy-sparse"' \
        '' \
        '[source.rsproxy-sparse]' \
        'registry = "sparse+https://rsproxy.cn/index/"' \
        '' \
        '[registries.rsproxy]' \
        'index = "https://rsproxy.cn/crates.io-index"' \
        '' \
        '[net]' \
        'git-fetch-with-cli = true' \
        > /root/.cargo/config.toml \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*

ENV PATH=/root/.cargo/bin:${PATH}

# Build dependency stage: compile third-party crates before copying app source.
FROM builder-base AS builder-deps

COPY executor/Cargo.toml executor/Cargo.lock /app/executor/
RUN mkdir -p /app/executor/src/bin \
    && printf 'pub fn placeholder() {}\n' > /app/executor/src/lib.rs \
    && printf 'fn main() {}\n' > /app/executor/src/bin/wegent-executor.rs \
    && cd /app/executor \
    && cargo build --release --locked --bin wegent-executor

# Build stage: compile executor Rust binary.
FROM builder-deps AS builder
ARG APP_VERSION=dev

COPY executor/src /app/executor/src
COPY shared/assets /app/shared/assets
RUN cd /app/executor \
    && find src -type f -exec touch {} + \
    && APP_VERSION="${APP_VERSION}" cargo build --release --locked --bin wegent-executor

# Runtime stage: internal executor environment plus the Rust binary.
FROM ${BASE_IMAGE}
ARG APP_VERSION=dev

WORKDIR /app

# Configure npm registry for China.
RUN npm config set registry https://registry.npmmirror.com

RUN npm install -g @anthropic-ai/claude-code@2.1.247 @openai/codex@0.137.0 \
    --registry=https://registry.npmmirror.com

# Keep uv available for skills that invoke Python tooling at runtime.
RUN pip install --no-cache-dir uv -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com \
    && uv --version

ENV UV_INDEX_URL="http://mirrors.cloud.aliyuncs.com/pypi/simple/"
ENV UV_EXTRA_INDEX_URL=""
ENV PATH="/usr/local/bin:${PATH}"

# Set Claude Code environment variables.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY="false"
ENV CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1
ENV CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Install system packages for document generation.
RUN dnf install -y --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
    libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
    poppler-utils pandoc tesseract \
    jq zip \
    && dnf clean all && rm -rf /var/cache/dnf/*

# Install npm packages for document generation using China mirror.
RUN set -eux; \
    npm install -g pptxgenjs playwright@1.57.0 sharp react react-dom react-icons docx pdf-lib --registry=https://registry.npmmirror.com; \
    if ! PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright npx playwright install chromium; then \
        echo "Mirror download failed, falling back to official Playwright CDN"; \
        npx playwright install chromium; \
    fi; \
    npm cache clean --force

# Install Python packages for document generation using China mirror.
RUN pip install -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com \
    python-pptx openpyxl python-docx reportlab Pillow pandas duckdb \
    pypdf pdfplumber pytesseract \
    "markitdown[pptx]" defusedxml weasyprint \
    pyyaml \
    && pip cache purge || true

# Download Chinese fonts for document generation from internal mirror.
RUN mkdir -p /usr/share/fonts/truetype/noto && \
    (curl -sL "http://maven.intra.weibo.com/nexus/service/local/repositories/releases/content/adobe-fonts/NotoSansCJKsc/1.0/NotoSansCJKsc-1.0.ttf" \
        -o /usr/share/fonts/truetype/noto/NotoSansCJKsc.ttf || \
     curl -sL "http://maven.intra.weibo.com/nexus/service/local/repositories/releases/content/adobe-fonts/source-han-sans/1.0/source-han-sans-1.0.ttf" \
        -o /usr/share/fonts/truetype/noto/SourceHanSansSC.ttf) && \
    fc-cache -f

# Copy the Rust executor binary to the stable path expected by executor_manager.
COPY --from=builder /app/executor/target/release/wegent-executor /app/executor

ENV PORT=10001
ENV EXECUTOR_MODE=docker
ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}
ENV NODE_PATH=/usr/lib/node_modules

# Run the Rust executor binary.
CMD ["/app/executor"]
