ARG BASE_IMAGE=ghcr.io/wecode-ai/wegent-base-python3.12:latest

FROM ${BASE_IMAGE} AS builder-base

WORKDIR /workspace/src/executor
RUN dnf install -y gcc ca-certificates openssl-devel pkgconf-pkg-config \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*

ENV PATH=/root/.cargo/bin:${PATH}

FROM builder-base AS builder-deps

COPY executor/Cargo.toml executor/Cargo.lock ./
RUN mkdir -p src/bin \
    && printf 'pub fn placeholder() {}\n' > src/lib.rs \
    && printf 'fn main() {}\n' > src/bin/wegent-executor.rs \
    && cargo build --release --locked --bin wegent-executor

FROM builder-deps AS builder

COPY executor/src ./src
COPY shared/assets /workspace/src/shared/assets
RUN find src -type f -exec touch {} + \
    && cargo build --release --locked --bin wegent-executor

FROM ${BASE_IMAGE}

RUN npm install -g @anthropic-ai/claude-code@2.1.247 \
    && npm cache clean --force

COPY --from=builder /workspace/src/executor/target/release/wegent-executor /app/executor
RUN chmod 0755 /app/executor

ENV NODE_PATH=/usr/lib/node_modules
ENV PORT=10001
ENV EXECUTOR_MODE=docker

CMD ["/app/executor"]
