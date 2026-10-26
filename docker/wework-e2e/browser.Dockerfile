FROM mcr.microsoft.com/playwright:v1.60.0-noble

ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.17
ARG PYTHON_VERSION=3.11

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
ENV UV_PYTHON_BIN_DIR=/usr/local/bin

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    curl \
    docker.io \
    libmagic1 \
    zstd \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && curl --proto '=https' --tlsv1.2 -LsSf \
    "https://astral.sh/uv/${UV_VERSION}/install.sh" \
    | env UV_INSTALL_DIR=/usr/local/bin sh \
  && uv python install --default "${PYTHON_VERSION}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN node --version \
  && docker --version \
  && pnpm --version \
  && uv --version \
  && uv run --no-project --python "${PYTHON_VERSION}" python -c \
    'import ssl; ssl.create_default_context(); print(ssl.OPENSSL_VERSION)' \
  && zstd --version \
  && ldconfig -p | grep -q 'libmagic\.so\.1' \
  && find /ms-playwright -type f \
    \( -name chrome -o -name headless_shell \) \
    -perm -111 -print -quit \
  | grep -q .
