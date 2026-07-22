FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /workspace/src/executor

COPY executor /workspace/src/executor
COPY shared/assets /workspace/src/shared/assets

RUN dnf install -y gcc ca-certificates openssl-devel pkgconf-pkg-config \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*

ENV PATH=/root/.cargo/bin:${PATH}

RUN cd /workspace/src/executor \
    && cargo build --release --locked \
    && npm install -g @anthropic-ai/claude-code@2.1.199 \
    && npm cache clean --force \
    && mkdir -p /app \
    && cp target/release/wegent-executor /app/executor \
    && chmod 0755 /app/executor

ENV NODE_PATH=/usr/lib/node_modules
ENV PORT=10001
ENV EXECUTOR_MODE=docker

CMD ["/app/executor"]
