# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- Build stage ----
FROM registry.api.weibo.com/wecode/node:22-slim AS builder

WORKDIR /app

RUN npm config set registry http://registry.npmmirror.com
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts/download-fonts.cjs ./scripts/
RUN npm ci
COPY frontend .
RUN npm run build

# ---- Production runtime stage ----
FROM registry.api.weibo.com/wecode/node:22-slim

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/server.cjs ./server.cjs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE ${PORT}

# Use custom server with WebSocket proxy support
# PORT and BACKEND_URL can be configured via environment variables
CMD ["node", "server.cjs"]