# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build base stage: Rust toolchain and native build dependencies.
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS builder-base
WORKDIR /app

RUN dnf install -y gcc ca-certificates openssl-devel pkgconf-pkg-config \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*

ENV PATH=/root/.cargo/bin:${PATH}

# Build dependency stage: compile third-party crates before copying app source.
FROM builder-base AS builder-deps

COPY executor/Cargo.toml executor/Cargo.lock /app/executor/
RUN mkdir -p /app/executor/src/bin \
    && printf 'pub fn placeholder() {}\n' > /app/executor/src/lib.rs \
    && printf 'fn main() {}\n' > /app/executor/src/bin/wegent-executor.rs \
    && cd /app/executor \
    && cargo build --release --locked --bin wegent-executor

# Build stage: compile executor Rust binary.
FROM builder-deps AS builder
ARG APP_VERSION=dev

COPY executor/src /app/executor/src
RUN cd /app/executor \
    && find src -type f -exec touch {} + \
    && APP_VERSION="${APP_VERSION}" cargo build --release --locked --bin wegent-executor

# Runtime base stage: slow-changing executor environment.
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS runtime-base
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
    && npm install -g @anthropic-ai/claude-code@2.1.142 @openai/codex@0.137.0 \
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

# Runtime stage: base environment plus the executor binary.
FROM runtime-base
ARG APP_VERSION=dev

# Copy the Rust executor binary to the stable path expected by executor_manager.
COPY --from=builder /app/executor/target/release/wegent-executor /app/executor

ENV PORT=10001
ENV EXECUTOR_MODE=docker
ENV EXECUTOR_STARTUP_MODE=http
ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}
ENV NODE_PATH=/usr/lib/node_modules

# Run the Rust executor binary
CMD ["/app/executor"]
