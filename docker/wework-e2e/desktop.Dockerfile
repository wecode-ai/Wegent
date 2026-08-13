FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.17

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    gnupg \
    git \
    imagemagick \
    libayatana-appindicator3-dev \
    libmagic1 \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    python3 \
    python3-venv \
    redis-server \
    sqlite3 \
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
  && rustc --version \
  && cargo --version
