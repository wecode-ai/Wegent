# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/ci/almalinux:9.4

RUN dnf upgrade -y \
 && dnf install -y epel-release curl-minimal gcc make git wget gnupg python3.12 python3.12-devel python3.12-pip which \
 && curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - \
 && dnf install -y nodejs \
 && dnf install -y java-1.8.0-openjdk-devel.x86_64 maven-openjdk8.noarch \
 && ln -sf /usr/bin/python3.12 /usr/bin/python \
 && ln -sf /usr/bin/python3.12 /usr/bin/python3 \
 && ln -sf /usr/bin/pip3.12 /usr/bin/pip3 \
 && ln -sf /usr/bin/pip3.12 /usr/bin/pip \
 && npm install -g @anthropic-ai/claude-code@2.0.25 \
 && wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz \
 && tar -xvf sqlite-autoconf-3500400.tar.gz \
 && cd sqlite-autoconf-3500400 \
 && ./configure --prefix=/usr/local \
 && make -j$(nproc) \
 && make install \
 && yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6 \
 && cd .. \
 && rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz \
 && wget -O glab_1.74.0_linux_amd64.rpm "https://gitlab.com/gitlab-org/cli/-/releases/v1.74.0/downloads/glab_1.74.0_linux_amd64.rpm" \
 && dnf install -y glab_1.74.0_linux_amd64.rpm \
 && rm -rf glab_1.74.0_linux_amd64.rpm \
 && glab --version \
 && dnf clean all \
 && yum clean all \
 && rm -rf /var/cache/yum/* /var/cache/dnf/*

# maven settings
COPY maven-settings.xml /etc/maven/settings.xml

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