FROM registry.api.weibo.com/ci/almalinux:9.4

# -------------------------
# 基础源配置（统一为公司镜像）
# -------------------------
RUN yum install -y almalinux-release almalinux-release-devel almalinux-repos epel-release && \
    dnf config-manager --enable crb && \
    dnf config-manager --disable epel-cisco-openh264 && \
    \
    curl https://mirrors.nevis.sina.com.cn/docker-ce/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo && \
    \
    # AlmaLinux 源替换（单行避免 Dockerfile 解析错误）
    sed -ri 's|^mirrorlist=|#mirrorlist=|g; s|#\s*baseurl=|baseurl=|g; s|repo.almalinux.org|mirrors.nevis.sina.com.cn|g; s|mirrors.cloud.aliyuncs.com|mirrors.nevis.sina.com.cn|g; s|repo.huaweicloud.com|mirrors.nevis.sina.com.cn|g' /etc/yum.repos.d/almalinux-*.repo && \
    sed -i '/debuginfo/,$ s|mirrors.nevis.sina.com.cn|repo.almalinux.org|g' /etc/yum.repos.d/almalinux-*.repo && \
    sed -i '/ Source/,$ s|mirrors.nevis.sina.com.cn|repo.almalinux.org|g' /etc/yum.repos.d/almalinux-*.repo && \
    \
    # EPEL 源替换
    sed -i 's|^metalink=|#metalink=|g; s|#baseurl=https://download.example/pub|baseurl=http://mirrors.nevis.sina.com.cn|g; s|repo.huaweicloud.com|mirrors.nevis.sina.com.cn|g' /etc/yum.repos.d/epel*.repo && \
    \
    # Docker CE 源替换
    sed -i 's|download.docker.com|mirrors.nevis.sina.com.cn/docker-ce|g' /etc/yum.repos.d/docker-ce.repo && \
    \
    dnf upgrade -y && \
    dnf install -y \
        curl-minimal gcc make git wget gnupg which \
        python3.12 python3.12-devel python3.12-pip \
        java-1.8.0-openjdk-devel.x86_64 maven-openjdk8.noarch \
        gh yq jq procps procps-ng net-tools psmisc lsof tree&& \
    \
    # Python 软链
    ln -sf /usr/bin/python3.12 /usr/bin/python && \
    ln -sf /usr/bin/python3.12 /usr/bin/python3 && \
    ln -sf /usr/bin/pip3.12 /usr/bin/pip && \
    \
    yum clean all && \
    rm -rf /var/cache/yum

# 禁用系统 module 并移除旧版本 Node.js
RUN dnf module disable -y nodejs && \
    dnf remove -y nodejs npm || true && curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && \
    dnf install -y nodejs && \
    npm install -g @anthropic-ai/claude-code@2.1.142

RUN wget -O glab_1.74.0_linux_amd64.rpm "https://gitlab.com/gitlab-org/cli/-/releases/v1.74.0/downloads/glab_1.74.0_linux_amd64.rpm" \
 && dnf install -y glab_1.74.0_linux_amd64.rpm \
 && rm -rf glab_1.74.0_linux_amd64.rpm

# -------------------------
# Go 环境安装（支持 GVM）
# -------------------------
COPY go.sh /tmp/dev-language/go.sh
COPY gvm /root/.gvm
RUN chmod +x /tmp/dev-language/go.sh
RUN /tmp/dev-language/go.sh

ENV PATH="/root/.gvm/gos/go1.23.2/bin:$PATH"
ENV GOPROXY="https://goproxy.cn,direct"
ENV GO111MODULE="on"
ENV GOROOT="/root/.gvm/gos/go1.23.2"
ENV GOPATH="/root/.gvm/pkgsets/go1.23.2/global"

# -------------------------
# Install a standalone SQLite CLI without replacing the system sqlite-libs
# -------------------------
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

# -------------------------
# Maven settings
# -------------------------
COPY maven-settings.xml /etc/maven/settings.xml


# -------------------------
# Sandbox 标识（Wegent / WeCode）
# -------------------------
ENV IS_SANDBOX=1


# -------------------------
# Docker 静态二进制（适合沙箱/CI）
# 支持 AMD64 + ARM64
# -------------------------
ARG TARGETARCH
ENV DOCKER_VERSION=25.0.3

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) ARCH="x86_64" ;; \
      arm64) ARCH="aarch64" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac; \
    curl -fsSL http://mirrors.cloud.aliyuncs.com/docker-ce/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz \
        | tar -xz; \
    mv docker/* /usr/bin/; \
    chmod +x /usr/bin/docker; \
    rm -rf docker


# -------------------------
# 清理临时文件
# -------------------------
RUN rm -rf /tmp/dev-language/* && \
    dnf clean all && yum clean all && \
    rm -rf /var/cache/yum/* /var/cache/dnf/*
