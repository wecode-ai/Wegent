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
    npm install -g @anthropic-ai/claude-code@2.0.25

RUN wget -O glab_1.74.0_linux_amd64.rpm "https://gitlab.com/gitlab-org/cli/-/releases/v1.74.0/downloads/glab_1.74.0_linux_amd64.rpm" \
 && dnf install -y glab_1.74.0_linux_amd64.rpm \
 && rm -rf glab_1.74.0_linux_amd64.rpm

# -------------------------
# Go 环境安装（支持 GVM）
# -------------------------
COPY *.sh /tmp/dev-language/
RUN chmod +x /tmp/dev-language/*.sh
RUN /tmp/dev-language/go.sh

ENV PATH="/root/.gvm/gos/go1.23.2/bin:$PATH"
ENV GOPROXY="http://mirrors.cloud.aliyuncs.com/goproxy/,https://goproxy.cn,direct"
ENV GO111MODULE="on"
ENV GOROOT="/root/.gvm/gos/go1.23.2"
ENV GOPATH="/root/.gvm/pkgsets/go1.23.2/global"

# -------------------------
# SQLite3 (安全方式安装，不破坏系统)
# -------------------------
RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && make install && \
    cd .. && rm -rf sqlite-autoconf* && \
    echo "/usr/local/lib" > /etc/ld.so.conf.d/sqlite3.conf && \
    ldconfig

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