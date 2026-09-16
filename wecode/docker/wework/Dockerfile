# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- Build stage ----
FROM registry.api.weibo.com/wecode/node:22-slim AS builder

WORKDIR /app
ARG VITE_APP_BASE_PATH=/wework/
ARG VITE_SOCKET_BASE_URL=wss://wss-wegent.intra.weibo.com
ARG VITE_SOCKET_PATH=/socket.io
ARG VITE_CLOUD_DEVICE_SCALING_WIKI_URL=https://wiki.api.weibo.com/zh/weibo_rd/dev/wecode/wegent-device

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

RUN npm config set registry https://registry.npmmirror.com
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
RUN pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY wework/package.json ./wework/package.json
COPY packages/chat-core/package.json ./packages/chat-core/package.json
COPY packages/collaboration/package.json ./packages/collaboration/package.json
RUN pnpm --filter wework... install --frozen-lockfile

COPY wework ./wework
COPY packages/chat-core ./packages/chat-core
COPY packages/collaboration ./packages/collaboration
COPY shared/assets ./shared/assets

ENV VITE_LOGIN_MODE=oidc
ENV VITE_OIDC_LOGIN_TEXT="使用 CAS 登录"

RUN VITE_APP_BASE_PATH="${VITE_APP_BASE_PATH}" \
    VITE_SOCKET_BASE_URL="${VITE_SOCKET_BASE_URL}" \
    VITE_SOCKET_PATH="${VITE_SOCKET_PATH}" \
    VITE_CLOUD_DEVICE_SCALING_WIKI_URL="${VITE_CLOUD_DEVICE_SCALING_WIKI_URL}" \
    pnpm --filter wework build

# ---- Production runtime stage ----
FROM registry.api.weibo.com/hongyu9/nginx:1.25-alpine

COPY --from=builder /app/wework/dist /usr/share/nginx/html
COPY default.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8080

CMD ["/docker-entrypoint.sh"]
