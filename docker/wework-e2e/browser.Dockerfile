FROM mcr.microsoft.com/playwright:v1.60.0-noble

ARG PNPM_VERSION=11.7.0

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    libmagic1 \
    zstd \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "pnpm@${PNPM_VERSION}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN node --version \
  && pnpm --version \
  && zstd --version \
  && ldconfig -p | grep -q 'libmagic\.so\.1' \
  && find /ms-playwright -type f \
    \( -name chrome -o -name headless_shell \) \
    -perm -111 -print -quit \
  | grep -q .
