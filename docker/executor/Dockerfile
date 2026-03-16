# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# ============================================================================
# Stage 1: deps — system packages + Python dependencies (shared by all targets)
# ============================================================================
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS deps

WORKDIR /app

# Install system packages for document generation (AlmaLinux uses dnf)
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

# Install Python executor dependencies (cached unless pyproject.toml changes)
COPY executor/pyproject.toml /app/executor/pyproject.toml
RUN cd /app/executor && uv pip install --system --no-cache -r pyproject.toml

ENV PORT=10001
ENV PYTHONPATH=/app
ENV NODE_PATH=/usr/lib/node_modules

# ============================================================================
# Stage 2: builder — compiles executor Python source to standalone binary
# ============================================================================
FROM deps AS builder

# Install PyInstaller
RUN uv pip install --system pyinstaller

# Copy source code and build binary
COPY executor /app/executor
COPY shared /app/shared
RUN cd /app/executor && bash build.sh

# ============================================================================
# Stage 3: source — dev target, runs Python source directly (no compilation)
#   docker build --target source -t wegent-executor:local-dev .
# ============================================================================
FROM deps AS source

COPY executor /app/executor
COPY shared /app/shared

CMD ["python", "/app/executor/main.py"]

# ============================================================================
# Stage 4: binary — default target, runs compiled standalone binary
#   docker build -t wegent-executor:latest .
# ============================================================================
FROM deps AS binary

COPY --from=builder /app/executor/dist/executor /app/executor

CMD ["/app/executor"]
