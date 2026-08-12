FROM mcr.microsoft.com/playwright:v1.60.0-noble

ARG PNPM_VERSION=11.7.0

RUN npm install --global "pnpm@${PNPM_VERSION}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN node --version \
  && pnpm --version \
  && test -x /ms-playwright/chromium-*/chrome-linux/chrome
