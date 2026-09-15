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
COPY patches ./patches
COPY frontend/package.json ./frontend/package.json
COPY frontend/scripts ./frontend/scripts
COPY frontend/.husky ./frontend/.husky
COPY packages/chat-core/package.json ./packages/chat-core/package.json
COPY packages/collaboration/package.json ./packages/collaboration/package.json
RUN echo "[frontend] installing pnpm dependencies" && \
    pnpm --filter wecode-ai-assistant... install --frozen-lockfile --reporter append-only && \
    echo "[frontend] pnpm dependencies installed"

COPY frontend ./frontend
COPY packages/chat-core ./packages/chat-core
COPY packages/collaboration ./packages/collaboration

ENV NEXT_TELEMETRY_DISABLED=1

RUN echo "[frontend] building Next.js app" && \
    pnpm --filter wecode-ai-assistant build && \
    echo "[frontend] Next.js app built"

# ---- Production runtime stage ----
FROM registry.api.weibo.com/wecode/node:22-slim

WORKDIR /app

COPY --from=builder /app/frontend/.next/standalone ./
COPY --from=builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=builder /app/frontend/public ./frontend/public

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE ${PORT}

CMD ["node", "frontend/server.js"]
