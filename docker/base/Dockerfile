# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM almalinux:latest

RUN dnf upgrade -y \
 && dnf install -y epel-release curl-minimal gcc make git wget gnupg python3.12 python3.12-devel python3.12-pip which \
 && curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - \
 && dnf install -y nodejs gh tar gzip\
 && ln -sf /usr/bin/python3.12 /usr/bin/python \
 && ln -sf /usr/bin/python3.12 /usr/bin/python3 \
 && ln -sf /usr/bin/pip3.12 /usr/bin/pip3 \
 && ln -sf /usr/bin/pip3.12 /usr/bin/pip \
 && npm install -g @anthropic-ai/claude-code@2.0.25 \
 && dnf clean all \
 && yum clean all \
 && rm -rf /var/cache/yum/* /var/cache/dnf/*

# claude code mode: bypassPermissions
ENV IS_SANDBOX=1

ARG TARGETARCH
ENV DOCKER_VERSION=25.0.3
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) ARCH="x86_64" ;; \
      arm64) ARCH="aarch64" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac; \
    echo "TARGETARCH=${TARGETARCH}, ARCH=${ARCH}"; \
    curl -fsSL https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz | tar -xz; \
    mv docker/* /usr/bin/; \
    chmod +x /usr/bin/docker; \
    rm -rf docker

RUN ARCH=$(uname -m) \
 && if [ "$ARCH" = "x86_64" ]; then \
      URL="https://gitlab.com/gitlab-org/cli/-/releases/v1.79.0/downloads/glab_1.79.0_linux_amd64.tar.gz"; \
      EXT="tar.gz"; \
    else \
      URL="https://gitlab.com/gitlab-org/cli/-/releases/v1.79.0/downloads/glab_1.79.0_linux_arm64.rpm"; \
      EXT="rpm"; \
    fi \
 && echo "Downloading glab from $URL" \
 && curl -fL "$URL" -o glab_package.$EXT \
 && if [ "$EXT" = "tar.gz" ]; then \
      tar -xzf glab_package.tar.gz -C /usr/local/bin --strip-components=1 glab; \
    else \
      dnf install -y ./glab_package.rpm; \
    fi \
 && rm -f glab_package.$EXT