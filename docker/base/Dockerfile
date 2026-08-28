# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM almalinux:9.4

RUN dnf upgrade -y \
 && dnf install -y epel-release curl-minimal vim gcc make git wget gnupg python3.12 python3.12-devel python3.12-pip which file file-libs \
    nspr nss nss-util atk at-spi2-atk cups-libs libxcb libxkbcommon at-spi2-core \
    libX11 libXcomposite libXdamage libXext libXfixes libXrandr mesa-libgbm cairo pango alsa-lib libdrm \
    # OCR dependencies for scanned PDF support
    tesseract tesseract-langpack-chi_sim tesseract-langpack-eng poppler-utils \
 && curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - \
 && dnf install -y nodejs gh tar gzip\
 && ln -sf /usr/bin/python3.12 /usr/bin/python \
 && ln -sf /usr/bin/python3.12 /usr/bin/python3 \
 && ln -sf /usr/bin/pip3.12 /usr/bin/pip3 \
 && ln -sf /usr/bin/pip3.12 /usr/bin/pip \
 && npm install -g @anthropic-ai/claude-code@2.1.247 \
 && npm cache clean --force \
 && dnf clean all \
 && yum clean all \
 && rm -rf /var/cache/yum/* /var/cache/dnf/* /root/.npm /tmp/*

# Install uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install Playwright Python package and Chromium browser for crawl4ai web scraping
# System dependencies are already installed in the main RUN command above
RUN pip install playwright \
    && playwright install chromium

# Install a standalone SQLite CLI for Agno image validation. Keep AlmaLinux's
# RPM-managed sqlite-libs unchanged because dnf and rpm depend on it.
ARG SQLITE_VERSION=3.50.4
ARG SQLITE_AUTOCONF_VERSION=3500400
ARG SQLITE_SHA256=a3db587a1b92ee5ddac2f66b3edb41b26f9c867275782d46c3a088977d6a5b18
RUN set -eux; \
    archive="sqlite-autoconf-${SQLITE_AUTOCONF_VERSION}.tar.gz"; \
    source_dir="sqlite-autoconf-${SQLITE_AUTOCONF_VERSION}"; \
    wget "https://www.sqlite.org/2025/${archive}"; \
    echo "${SQLITE_SHA256}  ${archive}" | sha256sum -c -; \
    tar -xzf "${archive}"; \
    cd "${source_dir}"; \
    ./configure --disable-shared; \
    make -j"$(nproc)" sqlite3; \
    install -m 0755 sqlite3 /usr/local/bin/sqlite3; \
    cd ..; \
    rm -rf "${source_dir}" "${archive}"; \
    sqlite3 --version | grep -q "^${SQLITE_VERSION} "; \
    ! ldd /usr/local/bin/sqlite3 | grep -q libsqlite3; \
    rpm -V sqlite-libs
ENV PATH="/usr/local/bin:${PATH}"

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

RUN if [ "$TARGETARCH" = "amd64" ]; then \
      URL="https://gitlab.com/gitlab-org/cli/-/releases/v1.79.0/downloads/glab_1.79.0_linux_amd64.tar.gz"; \
    else \
      URL="https://gitlab.com/gitlab-org/cli/-/releases/v1.79.0/downloads/glab_1.79.0_linux_arm64.tar.gz"; \
    fi \
 && echo "Downloading glab from $URL" \
 && curl -fL "$URL" -o glab_package.tar.gz \
 && mkdir -p /tmp/glab \
 && tar -xzf glab_package.tar.gz -C /tmp/glab \
 && find /tmp/glab -name glab -type f -executable -exec mv {} /usr/local/bin/glab \; \
 && chmod +x /usr/local/bin/glab \
 && rm -rf /tmp/glab glab_package.tar.gz
