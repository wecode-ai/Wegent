#
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

ARG DEVICE_BASE_IMAGE=ubuntu:22.04

# ---------------------------------------------------------------------------
# Builder stage: compile the wegent-executor binary with PyInstaller.
# The binary is built without the bundled Claude CLI because the runtime image
# provides claude via npm (@anthropic-ai/claude-code).
# Uses the same base image as runtime to ensure glibc compatibility.
# ---------------------------------------------------------------------------
FROM ${DEVICE_BASE_IMAGE} AS builder
ARG TARGETPLATFORM
ARG DEVICE_IMAGE_PLATFORM=${TARGETPLATFORM}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils \
    ca-certificates \
    curl \
    file \
    libpython3.10 \
    patchelf \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /build
COPY executor/ executor/
COPY shared/ shared/

WORKDIR /build/executor
RUN rm -rf .venv
RUN uv sync --group build --python /usr/bin/python3
RUN uv run python scripts/build_local.py --no-bundle-claude

# ---------------------------------------------------------------------------
# Runtime stage: the actual device image.
# ---------------------------------------------------------------------------
FROM ${DEVICE_BASE_IMAGE}
ARG TARGETPLATFORM
ARG DEVICE_IMAGE_PLATFORM=${TARGETPLATFORM}

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools, Python, Node.js 22, ttyd, and code-server.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    file \
    git \
    gnupg \
    python3 \
    python3-pip \
    software-properties-common \
    && add-apt-repository -y universe \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    ttyd \
    && npm install -g @anthropic-ai/claude-code@2.1.142 @openai/codex@0.137.0 \
    && curl -fsSL https://code-server.dev/install.sh | sh \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && apt-get purge -y --auto-remove software-properties-common \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

RUN set -e; \
    rootfs_arch="$(dpkg --print-architecture)"; \
    case "$DEVICE_IMAGE_PLATFORM" in \
        linux/amd64) test "$rootfs_arch" = "amd64" ;; \
        linux/arm64) test "$rootfs_arch" = "arm64" ;; \
        *) echo "Unsupported DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1 ;; \
    esac \
    || { echo "Base image architecture $rootfs_arch does not match DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1; }

# code-server 4.121.0 references VS Code's optional vsda browser assets, but
# the packaged OSS build does not include them. Provide a no-op implementation
# so those optional static requests return 200 instead of noisy 404s.
RUN set -e; \
    vsda_root="/usr/lib/code-server/lib/vscode/node_modules/vsda"; \
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
COPY --from=builder --chown=wegent:wegent /build/executor/dist/wegent-executor /app/executor
RUN set -e; \
    executor_type="$(file /app/executor)"; \
    case "$DEVICE_IMAGE_PLATFORM" in \
        linux/amd64) echo "$executor_type" | grep -q "ELF 64-bit.*x86-64" ;; \
        linux/arm64) echo "$executor_type" | grep -Eq "ELF 64-bit.*(ARM aarch64|aarch64)" ;; \
        *) echo "Unsupported DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1 ;; \
    esac \
    || { echo "$executor_type" >&2; echo "Built executor binary does not match DEVICE_IMAGE_PLATFORM=$DEVICE_IMAGE_PLATFORM" >&2; exit 1; } \
    && mkdir -p /home/wegent/.wecode/wegent-executor/bin \
    && cp /app/executor /home/wegent/.wecode/wegent-executor/bin/wegent-executor \
    && chmod 0755 /app/executor /home/wegent/.wecode/wegent-executor/bin/wegent-executor \
    && ln -sf /home/wegent/.wecode/wegent-executor/bin/wegent-executor /usr/local/bin/wegent-executor \
    && chown -R wegent:wegent /app /home/wegent

ENV PATH="/home/wegent/.wecode/wegent-executor/bin:/home/wegent/.wecode/bin:/home/wegent/.local/bin:${PATH}"
ENV EXECUTOR_MODE=local
ENV WEGENT_BACKEND_URL=http://localhost:8000
ENV WEGENT_EXECUTOR_HOME=/home/wegent/.wecode/wegent-executor
ENV DEVICE_PUBLIC_BASE_URL=
ENV DEVICE_SESSION_GATEWAY_HOST=0.0.0.0
ENV DEVICE_SESSION_GATEWAY_PORT=17888

RUN cat >/usr/local/bin/wegent-device-entrypoint <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export CODE_SERVER_PASSWORD="${CODE_SERVER_PASSWORD:-${PASSWORD:-wegent}}"
export PASSWORD="$CODE_SERVER_PASSWORD"
export EXECUTOR_MODE="${EXECUTOR_MODE:-local}"
export WEGENT_BACKEND_URL="${WEGENT_BACKEND_URL:-http://localhost:8000}"
export DEVICE_SESSION_GATEWAY_HOST="${DEVICE_SESSION_GATEWAY_HOST:-0.0.0.0}"
export DEVICE_SESSION_GATEWAY_PORT="${DEVICE_SESSION_GATEWAY_PORT:-17888}"
export DEVICE_CODE_SERVER_PORT="${DEVICE_CODE_SERVER_PORT:-18080}"

# Auto-detect public base URL if not explicitly set.
# Uses the container's routable IP address.
if [ -z "${DEVICE_PUBLIC_BASE_URL:-}" ]; then
    _device_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    _device_ip="${_device_ip:-localhost}"
    export DEVICE_PUBLIC_BASE_URL="http://${_device_ip}:${DEVICE_SESSION_GATEWAY_PORT}"
fi

mkdir -p "$HOME/.config/code-server"
printf "bind-addr: 127.0.0.1:%s\nauth: password\ncert: false\n" "$DEVICE_CODE_SERVER_PORT" >"$HOME/.config/code-server/config.yaml"

pids=()

# Persistent code-server instance. The device gateway logs in server-side and
# proxies project URLs, so the browser never receives CODE_SERVER_PASSWORD.
code-server /home/wegent \
    --bind-addr "127.0.0.1:${DEVICE_CODE_SERVER_PORT}" \
    --auth password \
    --disable-telemetry \
    --disable-update-check \
    >/tmp/code-server.log 2>&1 &
pids+=("$!")

if [ -n "${WEGENT_AUTH_TOKEN:-}" ]; then
    wegent-executor >/tmp/wegent-executor.log 2>&1 &
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

RUN code-server --install-extension weiboplat.wecoder-agent --force || \
    echo "Warning: failed to install weiboplat.wecoder-agent extension (marketplace may be unavailable)"

# Install wecode-cli-cc when the private token is provided as a BuildKit secret.
RUN --mount=type=secret,id=wecode_cli_cc_token \
    --mount=type=secret,id=wecode_cli_cc_install_url \
    WECODE_CLI_CC_TOKEN="$(cat /run/secrets/wecode_cli_cc_token 2>/dev/null || true)" \
    && WECODE_CLI_CC_INSTALL_URL="$(cat /run/secrets/wecode_cli_cc_install_url 2>/dev/null || true)" \
    && if [ -n "$WECODE_CLI_CC_TOKEN" ] || [ -n "$WECODE_CLI_CC_INSTALL_URL" ]; then \
        if [ -z "$WECODE_CLI_CC_TOKEN" ] || [ -z "$WECODE_CLI_CC_INSTALL_URL" ]; then \
            echo "Both wecode_cli_cc_token and wecode_cli_cc_install_url secrets are required to install wecode-cli-cc" >&2; \
            exit 1; \
        fi; \
        curl -fsSL -H "PRIVATE-TOKEN: ${WECODE_CLI_CC_TOKEN}" \
        "$WECODE_CLI_CC_INSTALL_URL" \
        | bash; \
    else \
        echo "Skipping wecode-cli-cc install because WECODE_CLI_CC_TOKEN is empty"; \
    fi

EXPOSE 17888 18080

CMD ["wegent-device-entrypoint"]
