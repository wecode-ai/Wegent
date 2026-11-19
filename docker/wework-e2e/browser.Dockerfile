FROM mcr.microsoft.com/playwright:v1.60.0-noble

ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.17

# Use the signed Ubuntu Azure archive over HTTPS for this CI image.
RUN sed -i -E 's@http://(archive|security)\.ubuntu\.com/ubuntu@https://azure.archive.ubuntu.com/ubuntu@g' \
    /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get -o APT::Update::Error-Mode=any update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    curl \
    docker.io \
    ffmpeg \
    iproute2 \
    openssl \
    socat \
    libmagic1 \
    zstd \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && curl --proto '=https' --tlsv1.2 -LsSf \
    "https://astral.sh/uv/${UV_VERSION}/install.sh" \
    | env UV_INSTALL_DIR=/usr/local/bin sh

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN node --version \
  && docker --version \
  && ip -Version \
  && openssl version \
  && command -v update-ca-certificates \
  && pnpm --version \
  && uv --version \
  && zstd --version \
  && ldconfig -p | grep -q 'libmagic\.so\.1' \
  && find /ms-playwright -type f \
    \( -name chrome -o -name headless_shell \) \
    -perm -111 -print -quit \
  | grep -q .
