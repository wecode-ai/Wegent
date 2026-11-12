FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.17

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Use the independently hosted kernel.org mirror while preserving Ubuntu's
# suites and archive signing keyring. Package signatures remain mandatory.
RUN sed -i -E 's#http://(archive|security)\.ubuntu\.com/ubuntu#http://mirrors.edge.kernel.org/ubuntu#g' \
      /etc/apt/sources.list.d/ubuntu.sources \
  && getent ahostsv4 mirrors.edge.kernel.org \
  && apt-get -o APT::Update::Error-Mode=any update \
  && apt-get install -y --no-install-recommends \
    apparmor \
    build-essential \
    ca-certificates \
    curl \
    file \
    fontconfig \
    fonts-noto-cjk \
    gdb \
    gnupg \
    gh \
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
    openjdk-21-jre-headless \
    pcmanfm \
    python3 \
    python3-venv \
    redis-server \
    skopeo \
    sqlite3 \
    umoci \
    x11-utils \
    xdg-utils \
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
  && java -version \
  && keytool -help >/dev/null \
  && gdb --version \
  && command -v file \
  && command -v xdg-mime \
  && command -v pcmanfm \
  && fc-match --format '%{family}\n' ':lang=zh-cn' | grep -F 'Noto Sans CJK' \
  && pnpm --version \
  && gh --version \
  && python3 --version \
  && uv --version \
  && mysqld --version \
  && skopeo --version \
  && umoci --version \
  && rustc --version \
  && cargo --version \
  && fc-match --format '%{family}\n' 'sans-serif:lang=zh-cn' \
  && fc-list :lang=zh family | grep -F 'Noto Sans CJK'
