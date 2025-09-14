# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- 构建阶段 ----
FROM node:22-slim AS builder

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend .
RUN npm run build

# ---- 生产运行阶段 ----
FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.js ./next.config.js


ENV NODE_ENV=production
ENV PORT=3000

EXPOSE ${PORT}

CMD ["sh", "-c", "npm start -- -p ${PORT}"]