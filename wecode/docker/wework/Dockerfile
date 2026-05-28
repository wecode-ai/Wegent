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
FROM registry.api.weibo.com/wecode/nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# SPA routing: all routes fall back to index.html
RUN echo 'server { \
    listen 8080; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location /health { \
        return 200 "ok"; \
        add_header Content-Type text/plain; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]