# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# syntax=docker/dockerfile:1
# ^ Enable BuildKit syntax for optimal parallel builds

# ---- Build wegent-web stage ----
FROM registry.api.weibo.com/wecode/node:22-slim AS web-builder

WORKDIR /app

RUN npm config set registry http://registry.npmmirror.com
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts/download-fonts.cjs ./scripts/
RUN npm ci
COPY frontend .
RUN npm run build

# ---- Build wegent-docs stage ----
FROM registry.api.weibo.com/wecode/node:22-slim AS docs-builder

WORKDIR /docs-build

RUN npm config set registry http://registry.npmmirror.com
COPY wegent-docs/package.json wegent-docs/package-lock.json ./
RUN npm ci
COPY wegent-docs .
RUN npm run build

# ---- Production runtime stage ----
FROM registry.api.weibo.com/wecode/node:22-slim

WORKDIR /app

# Copy wegent-web build artifacts
COPY --from=web-builder /app/package.json ./
COPY --from=web-builder /app/node_modules ./node_modules
COPY --from=web-builder /app/.next ./.next
COPY --from=web-builder /app/public ./public
COPY --from=web-builder /app/next.config.js ./next.config.js

# Copy wegent-docs build artifacts to /docs
COPY --from=docs-builder /docs-build/build /docs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE ${PORT}

CMD ["sh", "-c", "npm start -- -p ${PORT}"]
