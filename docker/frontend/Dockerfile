# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- 构建阶段 ----
FROM node:22-slim AS builder


WORKDIR /app

# 复制依赖文件并安装依赖
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# 复制源码并构建
COPY frontend .
RUN npm run build

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

# 设置用户权限
USER nextjs

# 环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE ${PORT}

# 使用 Next.js standalone 服务器启动
CMD ["node", "server.js"]