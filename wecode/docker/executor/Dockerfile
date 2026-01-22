# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go AS builder

WORKDIR /app

# Configure npm registry for China
RUN npm config set registry https://registry.npmmirror.com

# Install uv from PyPI using Aliyun mirror
RUN pip install --no-cache-dir uv -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com && \
    uv --version

# Configure uv to use Aliyun PyPI mirror
ENV UV_INDEX_URL="http://mirrors.cloud.aliyuncs.com/pypi/simple/"
ENV UV_EXTRA_INDEX_URL=""

RUN npm update -g @anthropic-ai/claude-code

# Set environment variables
ENV PATH="/usr/local/bin:${PATH}"
# Configure pip with China mirror and increase timeout
RUN pip config set global.index-url http://mirrors.cloud.aliyuncs.com/pypi/simple/ && \
    pip config set global.trusted-host mirrors.cloud.aliyuncs.com && \
    pip config set global.timeout 300

# Copy pyproject.toml and install dependencies
COPY executor/pyproject.toml /app/executor/pyproject.toml

ENV PATH="/usr/local/bin:${PATH}"
RUN cd /app/executor && uv pip install --system --no-cache -r pyproject.toml

# Copy source code
COPY executor /app/executor
COPY shared /app/shared

# Copy file_change_sender.py and its spec file for separate compilation
COPY file_change_sender.py /app/file_change_sender.py
COPY file_change_sender.spec /app/file_change_sender.spec

# Build standalone binaries
RUN cd /app/executor && bash build.sh

# Build file_change_sender binary
RUN cd /app && \
    pip install pyinstaller && \
    pyinstaller file_change_sender.spec --clean && \
    echo "file_change_sender binary built successfully" && \
    ls -lh /app/dist/file_change_sender

# Runtime stage: minimal image with only the binary
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go

WORKDIR /app

# Configure npm registry for China
RUN npm config set registry https://registry.npmmirror.com

RUN npm update -g @anthropic-ai/claude-code

# Install uv from PyPI using Aliyun mirror
RUN pip install --no-cache-dir uv -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com && \
    uv --version

# Configure uv to use Aliyun PyPI mirror
ENV UV_INDEX_URL="http://mirrors.cloud.aliyuncs.com/pypi/simple/"
ENV UV_EXTRA_INDEX_URL=""

ENV PATH="/usr/local/bin:${PATH}"

# Set claude code environment variables
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY="false"

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
    fc-cache -f

# Copy standalone binaries from builder
COPY --from=builder /app/executor/dist/executor /app/executor
COPY --from=builder /app/dist/file_change_sender /app/scripts/file_change_sender

# Copy WeCode specific config files
COPY claude_hooks.json /app/config/claude_hooks.json

ENV PORT=10001
ENV PYTHONPATH=/app
ENV NODE_PATH=/usr/lib/node_modules
ENV CUSTOM_CONFIG='{"wecode_config": "executor.wecode.config.config.WeCodeConfig"}'

# Run the standalone binary
CMD ["/app/executor"]

