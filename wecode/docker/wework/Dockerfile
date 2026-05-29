# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- Build stage ----
FROM registry.api.weibo.com/wecode/node:22-slim AS builder

WORKDIR /app

RUN npm config set registry http://registry.npmmirror.com
COPY wework/package.json wework/package-lock.json ./
RUN npm ci
COPY wework .
RUN npm run build

# ---- Production runtime stage ----
FROM registry.api.weibo.com/hongyu9/nginx:1.25-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY default.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8080

CMD ["/docker-entrypoint.sh"]