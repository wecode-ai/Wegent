# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- Build stage ----
FROM registry.api.weibo.com/wecode/node:22-slim AS builder

WORKDIR /app

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

RUN npm config set registry https://registry.npmmirror.com
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
RUN pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
COPY frontend/scripts ./frontend/scripts
COPY frontend/.husky ./frontend/.husky
COPY packages/chat-core/package.json ./packages/chat-core/package.json
RUN pnpm --filter wecode-ai-assistant... install --frozen-lockfile

COPY frontend ./frontend
COPY packages/chat-core ./packages/chat-core

ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter wecode-ai-assistant build

# ---- Production runtime stage ----
FROM registry.api.weibo.com/wecode/node:22-slim

WORKDIR /app

COPY --from=builder /app/frontend/.next/standalone ./
COPY --from=builder /app/frontend/.next/static ./.next/static
COPY --from=builder /app/frontend/public ./public


ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE ${PORT}

CMD ["node", "server.js"]
