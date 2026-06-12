# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ---- Dependencies Stage ----
FROM node:22-slim AS deps

WORKDIR /app

# Copy dependency files and postinstall scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/chat-core/package.json ./packages/chat-core/package.json
COPY frontend/package.json ./frontend/package.json
COPY frontend/scripts ./frontend/scripts

# Font download configuration for internal deployments
ARG GOOGLE_SANS_CSS_URLS=""
ARG SKIP_UI_FONT_DOWNLOAD=""
ARG SKIP_PDF_FONT_DOWNLOAD=""
ENV GOOGLE_SANS_CSS_URLS=${GOOGLE_SANS_CSS_URLS}
ENV SKIP_UI_FONT_DOWNLOAD=${SKIP_UI_FONT_DOWNLOAD}
ENV SKIP_PDF_FONT_DOWNLOAD=${SKIP_PDF_FONT_DOWNLOAD}
ENV HUSKY=0

# Install workspace dependencies needed by the frontend.
RUN corepack enable \
    && corepack prepare pnpm@10.34.3 --activate \
    && pnpm install --frozen-lockfile --filter wecode-ai-assistant...

# ---- Build Stage ----
FROM node:22-slim AS builder

WORKDIR /app

# App version injected at build time (e.g. "0.1.5")
ARG APP_VERSION="dev"
ENV NEXT_PUBLIC_APP_VERSION=${APP_VERSION}

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules

# Copy source code
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY frontend ./frontend

# Disable Next.js telemetry to speed up build
ENV NEXT_TELEMETRY_DISABLED=1
ENV HUSKY=0

# Build Next.js application
WORKDIR /app/frontend
RUN corepack enable \
    && corepack prepare pnpm@10.34.3 --activate \
    && pnpm run build

# ---- Production Stage ----
FROM node:22-slim AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy Next.js standalone output
COPY --from=builder /app/frontend/.next/standalone ./
COPY --from=builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/frontend/public ./frontend/public

# Create cache directory and set permissions
RUN mkdir -p frontend/.next/cache && chown -R nextjs:nodejs frontend/.next

# Set user permissions
USER nextjs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV RUNTIME_ENABLE_CHAT_CONTEXT=true

EXPOSE ${PORT}

# Start with Next.js standalone server
WORKDIR /app/frontend
CMD ["node", "server.js"]
