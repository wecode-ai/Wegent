FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.source="https://github.com/wecode-ai/Wegent"
LABEL org.opencontainers.image.description="System dependencies for Wework desktop E2E jobs"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        libmagic1 \
        sudo \
        tar \
        unzip \
        xz-utils \
        zstd \
    && rm -rf /var/lib/apt/lists/*

COPY .github/scripts/install-wework-tauri-system-dependencies.sh /tmp/wework-ci/
COPY .github/scripts/lib/apt-packages.sh /tmp/wework-ci/lib/

RUN /tmp/wework-ci/install-wework-tauri-system-dependencies.sh full redis \
    && rm -rf /tmp/wework-ci /var/lib/apt/lists/*
