# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS builder

WORKDIR /app

# Copy pyproject.toml and install dependencies
COPY executor/pyproject.toml /app/executor/pyproject.toml

RUN cd /app/executor && uv pip install --system --no-cache -r pyproject.toml

# Copy source code
COPY executor /app/executor
COPY shared /app/shared

# Build standalone binary
RUN cd /app/executor && bash build.sh

# Runtime stage: minimal image with only the binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /app

# Install system packages for document generation (AlmaLinux uses dnf)
RUN dnf install -y \
    # LibreOffice for document conversion and PDF operations
    libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
    # Document and PDF utilities
    poppler-utils pandoc tesseract \
    # Chromium dependencies for Playwright browser automation
    atk at-spi2-atk libXcomposite libXdamage libXfixes libXrandr libxkbcommon \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*

# Install Claude marketplace skills and npm packages for document generation
# Install to /root so it's available in the base image
RUN claude plugin marketplace add anthropics/skills \
    && npm install -g pptxgenjs playwright sharp react react-dom react-icons docx pdf-lib \
    && npx playwright install chromium \
    && npm cache clean --force

# Install Python packages for document generation
# These are commonly used by document skills
RUN pip install python-pptx openpyxl python-docx reportlab Pillow pandas \
    pypdf pdfplumber pytesseract \
    "markitdown[pptx]" defusedxml weasyprint \
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


# Copy only the standalone binary from builder
COPY --from=builder /app/executor/dist/executor /app/executor

ENV PORT=10001
ENV PYTHONPATH=/app
ENV NODE_PATH=/usr/lib/node_modules

# Run the standalone binary
CMD ["/app/executor"]
