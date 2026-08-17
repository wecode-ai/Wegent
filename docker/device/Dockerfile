#
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Public multi-architecture device image used by release pipelines.

ARG DEVICE_BASE_IMAGE=ubuntu:22.04

# ---------------------------------------------------------------------------
# Builder stage: compile the Rust wegent-executor binary.
# The runtime image provides claude via npm (@anthropic-ai/claude-code).
# Uses the same base image as runtime to ensure glibc compatibility.
# ---------------------------------------------------------------------------
FROM ${DEVICE_BASE_IMAGE} AS builder
ARG TARGETPLATFORM
ARG DEVICE_IMAGE_PLATFORM=${TARGETPLATFORM}
ARG APP_VERSION=dev
ARG DEVICE_APT_MIRROR=
ARG DEVICE_APT_PORTS_MIRROR=${DEVICE_APT_MIRROR}
ARG RUSTUP_INIT_URL=https://sh.rustup.rs
ARG RUSTUP_DIST_SERVER=
ARG RUSTUP_UPDATE_ROOT=
ARG CARGO_REGISTRIES_CRATES_IO_INDEX=
ARG CARGO_HTTPS_PROXY=

ENV DEBIAN_FRONTEND=noninteractive

RUN if [ -n "$DEVICE_APT_MIRROR" ]; then \
        sed -i \
          -e "s|http://archive.ubuntu.com/ubuntu|$DEVICE_APT_MIRROR|g" \
          -e "s|http://security.ubuntu.com/ubuntu|$DEVICE_APT_MIRROR|g" \
          -e "s|http://ports.ubuntu.com/ubuntu-ports|$DEVICE_APT_PORTS_MIRROR|g" \
          /etc/apt/sources.list; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN if [ -n "$RUSTUP_DIST_SERVER" ]; then export RUSTUP_DIST_SERVER; fi; \
    if [ -n "$RUSTUP_UPDATE_ROOT" ]; then export RUSTUP_UPDATE_ROOT; fi; \
    curl --proto '=https' --tlsv1.2 -sSf "$RUSTUP_INIT_URL" \
    | sh -s -- -y --profile minimal --default-toolchain stable

ENV PATH=/root/.cargo/bin:${PATH}

WORKDIR /build/executor
COPY executor/Cargo.toml executor/Cargo.lock ./
COPY executor/src ./src
COPY shared/assets /build/shared/assets
RUN if [ -n "$CARGO_REGISTRIES_CRATES_IO_INDEX" ]; then \
        export CARGO_REGISTRIES_CRATES_IO_INDEX; \
    fi; \
    if [ -n "$CARGO_HTTPS_PROXY" ]; then \
        export HTTPS_PROXY="$CARGO_HTTPS_PROXY"; \
        export https_proxy="$CARGO_HTTPS_PROXY"; \
    fi; \
    APP_VERSION="${APP_VERSION}" cargo build --release --locked

# ---------------------------------------------------------------------------
# Runtime stage: the actual device image.
# ---------------------------------------------------------------------------
FROM ${DEVICE_BASE_IMAGE}
ARG TARGETPLATFORM
ARG DEVICE_IMAGE_PLATFORM=${TARGETPLATFORM}
ARG APP_VERSION=dev
ARG VCS_REF=unknown
ARG DEVICE_APT_MIRROR=
ARG DEVICE_APT_PORTS_MIRROR=${DEVICE_APT_MIRROR}
ARG NODE_VERSION=22.23.2
ARG NODE_DIST_MIRROR=https://nodejs.org/dist
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG CODE_SERVER_VERSION=4.121.0
ARG CODE_SERVER_REPOSITORY_RAW=https://raw.githubusercontent.com/coder/code-server
ARG CODE_SERVER_HTTPS_PROXY=

ENV DEBIAN_FRONTEND=noninteractive
ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.revision=${VCS_REF}

# Install base tools, Python, and Node.js 22.
RUN if [ -n "$DEVICE_APT_MIRROR" ]; then \
        sed -i \
          -e "s|http://archive.ubuntu.com/ubuntu|$DEVICE_APT_MIRROR|g" \
          -e "s|http://security.ubuntu.com/ubuntu|$DEVICE_APT_MIRROR|g" \
          -e "s|http://ports.ubuntu.com/ubuntu-ports|$DEVICE_APT_PORTS_MIRROR|g" \
          /etc/apt/sources.list; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    file \
    git \
    python3 \
    python3-pip \
    xz-utils \
    && case "$DEVICE_IMAGE_PLATFORM" in \
        linux/amd64) node_arch=x64 ;; \
        linux/arm64) node_arch=arm64 ;; \
        *) echo "Unsupported DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1 ;; \
    esac \
    && curl -fsSL \
      "${NODE_DIST_MIRROR%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ --strip-components=1 -C /usr/local \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Install the agent CLIs from the selected npm registry.
RUN npm install -g --registry "$NPM_REGISTRY" \
      @anthropic-ai/claude-code@2.1.199 @openai/codex@0.142.5 \
    && npm cache clean --force

# Follow code-server's official install.sh flow, pinned to the selected release.
# Standalone mode avoids distro services and native npm compilation in the image.
RUN if [ -n "$CODE_SERVER_HTTPS_PROXY" ]; then \
      export HTTPS_PROXY="$CODE_SERVER_HTTPS_PROXY"; \
      export https_proxy="$CODE_SERVER_HTTPS_PROXY"; \
    fi \
    && curl -fsSL --retry 5 --retry-all-errors \
      "${CODE_SERVER_REPOSITORY_RAW%/}/v${CODE_SERVER_VERSION}/install.sh" \
      -o /tmp/install-code-server.sh \
    && sh /tmp/install-code-server.sh \
      --method=standalone \
      --prefix=/usr/local \
      --version="${CODE_SERVER_VERSION}" \
    && rm -f /tmp/install-code-server.sh \
    && installed_code_server_version="$(code-server --version | tail -n 1 | awk '{print $1}')" \
    && test "$installed_code_server_version" = "$CODE_SERVER_VERSION" \
    && rm -rf /root/.config/code-server

RUN set -e; \
    rootfs_arch="$(dpkg --print-architecture)"; \
    case "$DEVICE_IMAGE_PLATFORM" in \
        linux/amd64) test "$rootfs_arch" = "amd64" ;; \
        linux/arm64) test "$rootfs_arch" = "arm64" ;; \
        *) echo "Unsupported DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1 ;; \
    esac \
    || { echo "Base image architecture $rootfs_arch does not match DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1; }

# code-server references VS Code's optional vsda browser assets, but
# the packaged OSS build does not include them. Provide a no-op implementation
# so those optional static requests return 200 instead of noisy 404s.
RUN set -e; \
    vsda_root="/usr/local/lib/code-server-${CODE_SERVER_VERSION}/lib/vscode/node_modules/vsda"; \
    vsda_dir="$vsda_root/rust/web"; \
    mkdir -p "$vsda_dir"; \
    printf '%s\n' \
        '{"name":"vsda","version":"0.0.0","main":"index.js"}' \
        >"$vsda_root/package.json"; \
    printf '%s\n' \
        'class signer {' \
        '  sign(value) { return value; }' \
        '}' \
        'class validator {' \
        '  createNewMessage(value) { return value; }' \
        '  validate() { return "ok"; }' \
        '  free() {}' \
        '}' \
        'module.exports = { signer, validator };' \
        >"$vsda_root/index.js"; \
    printf '%s\n' \
        '(function (root) {' \
        '  var api = {' \
        '    default: async function () {},' \
        '    sign: function (value) { return value; },' \
        '    validator: class {' \
        '      createNewMessage(value) { return value; }' \
        '      validate() { return "ok"; }' \
        '      free() {}' \
        '    }' \
        '  };' \
        '  root.vsda_web = api;' \
        '  if (typeof define === "function") {' \
        '    define(function () { return api; });' \
        '  }' \
        '})(globalThis);' \
        >"$vsda_dir/vsda.js"; \
    : >"$vsda_dir/vsda_bg.wasm"

# Create the runtime user used by cloud and local device containers.
RUN groupadd -r wegent \
    && useradd -r -g wegent -m -d /home/wegent -s /bin/bash wegent \
    && echo "wegent:wegent" | chpasswd

WORKDIR /app

# Keep both paths available:
# - /app/executor is the executor-manager entrypoint-compatible path.
# - ~/.wecode/wegent-executor/bin/wegent-executor is the local device install path.
COPY --from=builder --chown=wegent:wegent /build/executor/target/release/wegent-executor /app/executor
RUN set -e; \
    executor_type="$(file /app/executor)"; \
    case "$DEVICE_IMAGE_PLATFORM" in \
        linux/amd64) echo "$executor_type" | grep -q "ELF 64-bit.*x86-64" ;; \
        linux/arm64) echo "$executor_type" | grep -Eq "ELF 64-bit.*(ARM aarch64|aarch64)" ;; \
        *) echo "Unsupported DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1 ;; \
    esac \
    || { echo "$executor_type" >&2; echo "Built executor binary does not match DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1; } \
    && mkdir -p \
        /home/wegent/.wecode/wegent-executor/bin \
        /home/wegent/.wecode/wegent-executor/workspace \
    && cp /app/executor /home/wegent/.wecode/wegent-executor/bin/wegent-executor \
    && chmod 0755 /app/executor /home/wegent/.wecode/wegent-executor/bin/wegent-executor \
    && ln -sf /home/wegent/.wecode/wegent-executor/bin/wegent-executor /usr/local/bin/wegent-executor \
    && test "$(/app/executor --version)" = "${APP_VERSION}" \
    && chown -R wegent:wegent /app /home/wegent

ENV PATH="/home/wegent/.wecode/wegent-executor/bin:/home/wegent/.wecode/bin:/home/wegent/.local/bin:${PATH}"
ENV WEGENT_BACKEND_URL=http://localhost:8000
ENV WEGENT_EXECUTOR_HOME=/home/wegent/.wecode/wegent-executor
ENV LOCAL_WORKSPACE_ROOT=/home/wegent/.wecode/wegent-executor/workspace
ENV WEGENT_WORKSPACE_ROOTS=/home/wegent
ENV DEVICE_PUBLIC_BASE_URL=
ENV DEVICE_SESSION_GATEWAY_HOST=0.0.0.0
ENV DEVICE_SESSION_GATEWAY_PORT=17888

RUN cat >/usr/local/bin/wegent-device-entrypoint <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export WEGENT_BACKEND_URL="${WEGENT_BACKEND_URL:-http://localhost:8000}"
export DEVICE_SESSION_GATEWAY_HOST="${DEVICE_SESSION_GATEWAY_HOST:-0.0.0.0}"
export DEVICE_SESSION_GATEWAY_PORT="${DEVICE_SESSION_GATEWAY_PORT:-17888}"
export DEVICE_CODE_SERVER_PORT="${DEVICE_CODE_SERVER_PORT:-18080}"
DEVICE_LOG_DIR="$WEGENT_EXECUTOR_HOME/logs"

# A named volume mounted at WEGENT_EXECUTOR_HOME may contain an older binary.
# Refresh only the binary from the current image and preserve the remaining data.
mkdir -p "$WEGENT_EXECUTOR_HOME/bin" "$LOCAL_WORKSPACE_ROOT" "$DEVICE_LOG_DIR"
install -m 0755 /app/executor "$WEGENT_EXECUTOR_HOME/bin/wegent-executor"

# Auto-detect public base URL if not explicitly set.
# Uses the container's routable IP address.
if [ -z "${DEVICE_PUBLIC_BASE_URL:-}" ]; then
    _device_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    _device_ip="${_device_ip:-localhost}"
    export DEVICE_PUBLIC_BASE_URL="http://${_device_ip}:${DEVICE_SESSION_GATEWAY_PORT}"
fi

mkdir -p "$HOME/.config/code-server"
printf "bind-addr: 127.0.0.1:%s\nauth: none\ncert: false\n" "$DEVICE_CODE_SERVER_PORT" >"$HOME/.config/code-server/config.yaml"

pids=()

# Match the local device installer: code-server only listens on loopback and
# leaves remote authentication to the token-gated device session gateway.
code-server /home/wegent \
    --bind-addr "127.0.0.1:${DEVICE_CODE_SERVER_PORT}" \
    --auth none \
    --disable-telemetry \
    --disable-update-check \
    >"$DEVICE_LOG_DIR/code-server.log" \
    2>"$DEVICE_LOG_DIR/code-server-error.log" &
pids+=("$!")

if [ -n "${WEGENT_AUTH_TOKEN:-}" ]; then
    wegent-executor >"$DEVICE_LOG_DIR/wegent-executor.log" 2>&1 &
    pids+=("$!")
else
    echo "WEGENT_AUTH_TOKEN is not set; skipping wegent-executor startup" >&2
fi

trap 'if [ "${#pids[@]}" -gt 0 ]; then kill "${pids[@]}" 2>/dev/null || true; fi' TERM INT EXIT
if [ "${#pids[@]}" -gt 0 ]; then
    wait -n "${pids[@]}"
else
    tail -f /dev/null
fi
EOF

RUN chmod 0755 /usr/local/bin/wegent-device-entrypoint

USER wegent

EXPOSE 17888 18080

CMD ["wegent-device-entrypoint"]
