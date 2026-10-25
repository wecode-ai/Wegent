# Same MinIO version as docker-compose.e2e.yml, pinned for clean amd64/arm64 builds.
FROM bitnamilegacy/minio@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7 AS minio

FROM ubuntu:24.04

COPY --from=minio /opt/bitnami/minio/bin/minio /usr/local/bin/minio

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.17

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    apparmor \
    build-essential \
    ca-certificates \
    curl \
    gnupg \
    git \
    imagemagick \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatspi2.0-0t64 \
    libayatana-appindicator3-dev \
    libdrm2 \
    libgbm1 \
    libgtk-3-0t64 \
    libmagic1 \
    libnss3 \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libxshmfence1 \
    libxss1 \
    mysql-server \
    openbox \
    python3 \
    python3-venv \
    redis-server \
    skopeo \
    sqlite3 \
    umoci \
    x11-utils \
    xvfb \
    zstd \
  && curl --proto '=https' --tlsv1.2 -fsSL \
    "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "pnpm@${PNPM_VERSION}" \
  && curl --proto '=https' --tlsv1.2 -LsSf \
    "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin sh \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable

ENV PATH="/root/.cargo/bin:${PATH}"

# Claude Code permits bypassPermissions for root only inside an explicit sandbox.
ENV IS_SANDBOX=1

RUN node --version \
  && pnpm --version \
  && python3 --version \
  && uv --version \
  && mysqld --version \
  && minio --version \
  && skopeo --version \
  && umoci --version \
  && rustc --version \
  && cargo --version
