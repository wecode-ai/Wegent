# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- Dependencies Stage ----
FROM node:22-slim AS deps

WORKDIR /app

# Copy dependency files and postinstall scripts
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts ./scripts

# Install dependencies (this layer will be cached, only reinstall when package.json changes)
RUN npm ci && npm cache clean --force

# ---- Build Stage ----
FROM node:22-slim AS builder

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY frontend .

# Disable Next.js telemetry to speed up build
ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js application
RUN npm run build

# ---- Production Stage ----
FROM node:22-slim AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Create cache directory and set permissions
RUN mkdir -p .next/cache && chown -R nextjs:nodejs .next

# Set user permissions
USER nextjs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV RUNTIME_ENABLE_CHAT_CONTEXT=true

EXPOSE ${PORT}

# Start with Next.js standalone server
CMD ["node", "server.js"]
