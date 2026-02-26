# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Standalone Dockerfile - All services in one container
# This builds a single image containing Backend, Frontend, Chat Shell, and Executor

# ========== Stage 1: Build Frontend ==========
FROM node:22-slim AS frontend-builder

WORKDIR /app

# Copy dependency files and postinstall scripts
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts ./scripts

# Install dependencies
RUN npm ci && npm cache clean --force

# Copy source code
COPY frontend .

# Disable Next.js telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js application
RUN npm run build

# ========== Stage 2: Build Python Base with Tools ==========
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS python-base

WORKDIR /app

# Verify Node.js is available (already installed in base image)
RUN node --version && npm --version

# Install system packages for document generation
RUN dnf install -y \
    # LibreOffice for document conversion and PDF operations
    libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
    # Document and PDF utilities
    poppler-utils pandoc tesseract \
    # Chromium dependencies for Playwright browser automation
    atk at-spi2-atk libXcomposite libXdamage libXfixes libXrandr libxkbcommon \
    # Skill-creator dependencies (JSON parsing and packaging)
    jq zip \
    && npm install -g @anthropic-ai/claude-code@2.1.33 \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*

# Install Claude marketplace skills and npm packages for document generation
RUN claude plugin marketplace add anthropics/skills \
    && npm install -g pptxgenjs playwright sharp react react-dom react-icons docx pdf-lib \
    && npx playwright install chromium \
    && npm cache clean --force

# Install Python packages for document generation
RUN pip install python-pptx openpyxl python-docx reportlab Pillow pandas \
    pypdf pdfplumber pytesseract \
    "markitdown[pptx]" defusedxml weasyprint \
    pyyaml \
    && pip cache purge || true

# Download Chinese fonts for document generation
RUN mkdir -p /usr/share/fonts/truetype/noto && \
    (curl -sL "https://github.com/googlefonts/noto-cjk/raw/main/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf" \
        -o /usr/share/fonts/truetype/noto/NotoSansCJKsc.ttf || \
     curl -sL "https://github.com/adobe-fonts/source-han-sans/raw/release/Variable/TTF/SourceHanSansSC-VF.ttf" \
        -o /usr/share/fonts/truetype/noto/SourceHanSansSC.ttf || \
     curl -sL "https://fonts.gstatic.com/s/notosanssc/v36/k3kXo84MPvpLmixcA63oeALhL4Gxr9Ov.ttf" \
        -o /usr/share/fonts/truetype/noto/NotoSansSC.ttf) && \
    fc-cache -f -v

# ========== Stage 3: Runtime ==========
FROM python-base AS runtime

WORKDIR /app

# Copy all Python modules to /app directory for consistent structure
# All modules will be under /app: /app/shared, /app/chat_shell, /app/executor, /app/backend
COPY shared /app/shared
COPY chat_shell /app/chat_shell
COPY executor /app/executor

# Install shared module first
RUN uv pip install --system --no-cache /app/shared

# Install chat_shell (depends on shared via ../shared -> /app/shared)
RUN cd /app/chat_shell && uv pip install --system --no-cache -r pyproject.toml

# Install executor (depends on shared via ../shared -> /app/shared)
RUN cd /app/executor && uv pip install --system --no-cache -r pyproject.toml

# Copy and install backend
# Backend's pyproject.toml references:
# - wegent-shared = { path = "../shared" } -> /app/shared
# - wegent-chat-shell = { path = "../chat_shell" } -> /app/chat_shell
COPY backend/pyproject.toml /app/backend/pyproject.toml
RUN cd /app/backend && uv pip install --system --no-cache -r pyproject.toml

# Copy backend application code
COPY backend/app /app/backend/app
COPY backend/alembic /app/backend/alembic
COPY backend/alembic.ini /app/backend/alembic.ini

# Copy frontend build (standalone output)
COPY --from=frontend-builder /app/.next/standalone /app/frontend
COPY --from=frontend-builder /app/.next/static /app/frontend/.next/static
COPY --from=frontend-builder /app/public /app/frontend/public

# Copy init_data directory with default resources and skills
COPY backend/init_data /app/init_data

# Copy startup script
COPY docker/standalone/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Environment variables for standalone mode
ENV STANDALONE_MODE=true
ENV ENVIRONMENT=development
# Note: SQLite absolute path requires 4 slashes: sqlite:////path/to/db
ENV DATABASE_URL=sqlite:////app/data/wegent.db
ENV CHAT_SHELL_MODE=package
ENV PYTHONPATH=/app:/app/backend:/app/chat_shell:/app/executor
ENV NODE_PATH=/usr/lib/node_modules

# Server configuration
ENV BACKEND_PORT=8000
ENV FRONTEND_PORT=3000
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600

# Expose ports
EXPOSE 3000 8000

# Data volume for SQLite database and other persistent data
VOLUME ["/app/data"]

# Health check - verify both services are running
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/health && curl -f http://localhost:3000 || exit 1

# Startup command
CMD ["/app/start.sh"]
