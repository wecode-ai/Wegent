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

# nginx config template with BACKEND_URL placeholder
RUN echo 'server { \
    listen 8080; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    \
    location /api/ { \
        proxy_pass ${BACKEND_URL}; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
        proxy_set_header X-Forwarded-Proto $scheme; \
    } \
    \
    location /socket.io/ { \
        proxy_pass ${BACKEND_URL}; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
        proxy_set_header X-Forwarded-Proto $scheme; \
    } \
    \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    \
    location /health { \
        return 200 "ok"; \
        add_header Content-Type text/plain; \
    } \
}' > /etc/nginx/conf.d/default.conf.template

# Startup script: substitute BACKEND_URL and start nginx
RUN printf '#!/bin/sh\nenvsubst "\\${BACKEND_URL}" < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf\nexec nginx -g "daemon off;"\n' > /docker-entrypoint.sh \
    && chmod +x /docker-entrypoint.sh

EXPOSE 8080

CMD ["/docker-entrypoint.sh"]