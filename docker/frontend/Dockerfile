# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- 构建阶段 ----
FROM node:22-slim AS builder


WORKDIR /app

# 复制依赖文件和 postinstall 所需的脚本
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts ./scripts
RUN npm ci && npm cache clean --force

# 复制其余源码
COPY frontend .
# 修改 API URL 为 Docker 内部服务名
RUN sed -i 's|NEXT_PUBLIC_API_URL=http://127.0.0.1:8000|NEXT_PUBLIC_API_URL=http://backend:8000|g' .env.local && npm run build

# ---- 生产运行阶段 ----
FROM node:22-slim AS runner

WORKDIR /app

# 创建非root用户
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 复制 Next.js standalone 输出
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 创建 cache 目录并设置权限
RUN mkdir -p .next/cache && chown -R nextjs:nodejs .next

# 设置用户权限
USER nextjs

# 环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE ${PORT}

# 使用 Next.js standalone 服务器启动
CMD ["node", "server.js"]