# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build on the runtime distribution so the gateway uses a compatible glibc.
FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS rust-builder-base
WORKDIR /app/backend-rs

# NASM is provided by CRB, which is disabled in the base image.
RUN dnf install -y gcc gcc-c++ make cmake zlib-devel ca-certificates openssl-devel pkgconf-pkg-config \
    && if [ "$(uname -m)" = x86_64 ]; then dnf --enablerepo=crb install -y nasm; fi \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*
ENV PATH=/root/.cargo/bin:${PATH}

# Cache dependency compilation independently of application source changes.
FROM rust-builder-base AS rust-builder-deps
COPY backend-rs/Cargo.toml backend-rs/Cargo.lock ./
RUN mkdir src \
    && printf 'pub fn placeholder() {}\n' > src/lib.rs \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked --bin wegent-backend-rs

FROM rust-builder-deps AS rust-builder
COPY backend-rs/src ./src
RUN find src -type f -exec touch {} + \
    && cargo build --release --locked --bin wegent-backend-rs

FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS runtime

# Set working directory
WORKDIR /app

# Copy local workspace dependencies so backend can resolve them via
# `pyproject.toml` [tool.uv.sources] relative paths from /app/backend:
# - wegent-shared = { path = "../shared" } -> /app/shared
# - wegent-chat-shell = { path = "../chat_shell" } -> /app/chat_shell
# - wegent-knowledge-engine = { path = "../knowledge_engine" } -> /app/knowledge_engine
COPY shared /app/shared
COPY chat_shell /app/chat_shell
COPY knowledge_engine /app/knowledge_engine

# Copy pyproject.toml and install dependencies
COPY backend/pyproject.toml /app/backend/pyproject.toml
RUN cd /app/backend && uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY backend /app

COPY --from=rust-builder /app/backend-rs/target/release/wegent-backend-rs /usr/local/bin/wegent-backend-rs
COPY backend-rs/config /app/backend-rs/config
COPY backend-rs/scripts/start-hybrid-backend.sh /app/backend-rs/scripts/start-hybrid-backend.sh
RUN chmod 0755 /usr/local/bin/wegent-backend-rs /app/backend-rs/scripts/start-hybrid-backend.sh \
    && command -v uvicorn >/dev/null \
    && ldd /usr/local/bin/wegent-backend-rs > /tmp/backend-rs-libraries \
    && ! grep -q 'not found' /tmp/backend-rs-libraries \
    && rm /tmp/backend-rs-libraries

# Copy init_data directory with default resources and skills into the image
# This includes:
# - 01-default-resources.yaml: Default Ghost, Model, Shell, Bot, Team resources
# - 02-public-shells.yaml: Public shell configurations
# - skills/: Skill packages (mermaid-diagram, wiki_submit, sandbox)
COPY backend/init_data /app/init_data

# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Default: 600 seconds (10 minutes) for long-running streaming requests to complete
ENV GRACEFUL_SHUTDOWN_TIMEOUT=600
ENV WEGENT_PYTHON_BACKEND_DIR=/app \
    WEGENT_PYTHON_RELOAD=false \
    WEGENT_RS_BINARY_PATH=/usr/local/bin/wegent-backend-rs
# Expose port
EXPOSE ${PORT}

# The launcher is PID 1 and owns both child processes and shutdown forwarding.
CMD ["bash", "-c", "WEGENT_PYTHON_UVICORN=\"$(command -v uvicorn)\" exec /app/backend-rs/scripts/start-hybrid-backend.sh --port \"${PORT}\""]

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1
