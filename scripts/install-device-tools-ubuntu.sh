#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Install the Ubuntu device tools used by docker/device/Dockerfile:
# ttyd and code-server. The script is safe to run repeatedly.

set -euo pipefail

CODE_SERVER_INSTALL_URL="${CODE_SERVER_INSTALL_URL:-https://code-server.dev/install.sh}"
CODE_SERVER_INSTALL_URLS="${CODE_SERVER_INSTALL_URLS:-${CODE_SERVER_INSTALL_URL} https://raw.githubusercontent.com/coder/code-server/main/install.sh}"
CODE_SERVER_INSTALL_METHOD="${CODE_SERVER_INSTALL_METHOD:-deb}"
CODE_SERVER_VERSION="${CODE_SERVER_VERSION:-latest}"
CODE_SERVER_DEB_PROXY_PREFIXES="${CODE_SERVER_DEB_PROXY_PREFIXES:-https://gh-proxy.com/ }"
INSTALL_WECODER_AGENT="${INSTALL_WECODER_AGENT:-true}"
WECODER_AGENT_EXTENSION_ID="${WECODER_AGENT_EXTENSION_ID:-weiboplat.wecoder-agent}"
WECODER_AGENT_VSIX="${WECODER_AGENT_VSIX:-}"
WECODER_AGENT_INSTALL_TIMEOUT_SECONDS="${WECODER_AGENT_INSTALL_TIMEOUT_SECONDS:-300}"
WECODER_AGENT_REQUIRED="${WECODER_AGENT_REQUIRED:-false}"
CODE_SERVER_USER="${CODE_SERVER_USER:-}"
CODE_SERVER_AUTH="${CODE_SERVER_AUTH:-password}"
CODE_SERVER_PASSWORD="${CODE_SERVER_PASSWORD:-password}"
CODE_SERVER_BIND_ADDR="${CODE_SERVER_BIND_ADDR:-0.0.0.0:18080}"
CODE_SERVER_CONFIG_DIR="${CODE_SERVER_CONFIG_DIR:-}"
CODE_SERVER_EXTENSIONS_DIR="${CODE_SERVER_EXTENSIONS_DIR:-}"
DISABLE_TTYD_SERVICE="${DISABLE_TTYD_SERVICE:-true}"
INSTALL_NODEJS="${INSTALL_NODEJS:-false}"
NODE_MAJOR="${NODE_MAJOR:-22}"
NODE_VERSION="${NODE_VERSION:-}"
NODE_DIST_MIRROR="${NODE_DIST_MIRROR:-https://npmmirror.com/mirrors/node}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NPM_LOGLEVEL="${NPM_LOGLEVEL:-info}"
INSTALL_CODEX_CLI="${INSTALL_CODEX_CLI:-true}"
CODEX_CLI_PACKAGE="${CODEX_CLI_PACKAGE:-@openai/codex@0.137.0}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
NPM_BIN="${NPM_BIN:-/usr/local/bin/npm}"
NPX_BIN="${NPX_BIN:-/usr/local/bin/npx}"
APT_LOCK_WAIT_SECONDS="${APT_LOCK_WAIT_SECONDS:-600}"
CURL_RETRY_COUNT="${CURL_RETRY_COUNT:-5}"
CURL_RETRY_DELAY_SECONDS="${CURL_RETRY_DELAY_SECONDS:-3}"
CURL_LOW_SPEED_LIMIT="${CURL_LOW_SPEED_LIMIT:-1024}"
CURL_LOW_SPEED_TIME="${CURL_LOW_SPEED_TIME:-30}"

info() {
    printf '[INFO] %s\n' "$*"
}

success() {
    printf '[SUCCESS] %s\n' "$*"
}

error() {
    printf '[ERROR] %s\n' "$*" >&2
}

apt_lock_holders() {
    if command -v fuser >/dev/null 2>&1; then
        $SUDO fuser \
            /var/lib/apt/lists/lock \
            /var/lib/dpkg/lock \
            /var/lib/dpkg/lock-frontend \
            /var/cache/apt/archives/lock \
            2>/dev/null || true
        return
    fi

    if command -v pgrep >/dev/null 2>&1; then
        pgrep -x 'apt|apt-get|aptd|dpkg|unattended-upgrade' 2>/dev/null || true
    fi
}

run_apt() {
    local started_at now elapsed status holders
    started_at="$(date +%s)"

    while true; do
        if $SUDO "$@"; then
            return 0
        fi

        status=$?
        holders="$(apt_lock_holders)"
        if [ -z "$holders" ]; then
            return "$status"
        fi

        now="$(date +%s)"
        elapsed=$((now - started_at))
        if [ "$elapsed" -ge "$APT_LOCK_WAIT_SECONDS" ]; then
            error "APT/dpkg lock is still held after ${APT_LOCK_WAIT_SECONDS}s by process(es): ${holders}"
            return "$status"
        fi

        info "APT/dpkg lock is held by process(es): ${holders}. Waiting 5s..."
        sleep 5
    done
}

download_with_retry() {
    local url="$1"
    local output="$2"

    curl \
        --fail \
        --show-error \
        --location \
        --retry "$CURL_RETRY_COUNT" \
        --retry-delay "$CURL_RETRY_DELAY_SECONDS" \
        --retry-connrefused \
        --connect-timeout 20 \
        --speed-limit "$CURL_LOW_SPEED_LIMIT" \
        --speed-time "$CURL_LOW_SPEED_TIME" \
        --max-time 300 \
        "$url" \
        -o "$output"
}

download_first_available() {
    local output="$1"
    shift
    local url

    for url in "$@"; do
        info "Downloading ${url}..."
        if download_with_retry "$url" "$output"; then
            return 0
        fi
        info "Download failed from ${url}; trying the next source..."
    done

    error "All download sources failed."
    return 1
}

resolve_code_server_version() {
    local metadata_file

    if [ "$CODE_SERVER_VERSION" != "latest" ]; then
        printf '%s' "${CODE_SERVER_VERSION#v}"
        return
    fi

    metadata_file="$(mktemp)"
    download_with_retry "${NPM_REGISTRY%/}/code-server/latest" "$metadata_file"
    sed -nE 's/.*"version":"([^"]+)".*/\1/p' "$metadata_file" | head -n 1
    rm -f "$metadata_file"
}

require_ubuntu() {
    if [ ! -r /etc/os-release ]; then
        error "Cannot detect OS because /etc/os-release is missing."
        exit 1
    fi

    # shellcheck disable=SC1091
    . /etc/os-release
    if [ "${ID:-}" != "ubuntu" ]; then
        error "This installer supports Ubuntu only. Detected: ${PRETTY_NAME:-unknown}."
        exit 1
    fi
}

configure_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
        return
    fi

    if ! command -v sudo >/dev/null 2>&1; then
        error "sudo is required when running as a non-root user."
        exit 1
    fi

    SUDO="sudo"
}

apt_install_base_packages() {
    info "Installing base packages..."
    run_apt apt-get update
    run_apt apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        software-properties-common \
        xz-utils
}

enable_universe_repository() {
    info "Enabling Ubuntu universe repository..."
    $SUDO add-apt-repository -y universe
    run_apt apt-get update
}

install_nodejs_if_requested() {
    if [ "$INSTALL_NODEJS" != "true" ]; then
        info "Skipping explicit Node.js installation. It will be installed automatically if code-server needs npm."
        return
    fi

    install_nodejs_from_npmmirror
}

detect_node_dist_arch() {
    local machine
    machine="$(uname -m)"

    case "$machine" in
        x86_64 | amd64)
            printf 'x64'
            ;;
        aarch64 | arm64)
            printf 'arm64'
            ;;
        *)
            error "Unsupported CPU architecture for Node.js binary install: ${machine}"
            exit 1
            ;;
    esac
}

current_node_major() {
    local node_cmd
    node_cmd="$(preferred_node_command || true)"
    if [ -z "$node_cmd" ]; then
        return 1
    fi

    "$node_cmd" --version | sed -E 's/^v([0-9]+).*/\1/'
}

preferred_node_command() {
    if [ -x "$NODE_BIN" ]; then
        printf '%s' "$NODE_BIN"
        return
    fi

    if command -v node >/dev/null 2>&1; then
        command -v node
    fi
}

preferred_npm_command() {
    if [ -x "$NPM_BIN" ]; then
        printf '%s' "$NPM_BIN"
        return
    fi

    if command -v npm >/dev/null 2>&1; then
        command -v npm
    fi
}

resolve_node_version() {
    if [ -n "$NODE_VERSION" ]; then
        printf '%s' "${NODE_VERSION#v}"
        return
    fi

    download_with_retry "${NODE_DIST_MIRROR}/index.json" "$TMP_NODE_INDEX"
    sed -nE "s/.*\"version\":\"v(${NODE_MAJOR}\.[0-9]+\.[0-9]+)\".*/\1/p" "$TMP_NODE_INDEX" | head -n 1
}

install_nodejs_from_npmmirror() {
    local current_major current_node_cmd node_version node_arch node_url install_parent install_dir tmp_archive

    current_major="$(current_node_major || true)"
    if [ -n "$current_major" ] && [ "$current_major" -eq "$NODE_MAJOR" ]; then
        current_node_cmd="$(preferred_node_command)"
        info "Node.js $("${current_node_cmd}" --version) is already installed at ${current_node_cmd}."
        return
    fi

    info "Installing Node.js ${NODE_MAJOR}.x from ${NODE_DIST_MIRROR}..."
    TMP_NODE_INDEX="$(mktemp)"
    node_version="$(resolve_node_version)"
    rm -f "$TMP_NODE_INDEX"

    if [ -z "$node_version" ]; then
        error "Failed to resolve latest Node.js ${NODE_MAJOR}.x version from ${NODE_DIST_MIRROR}."
        exit 1
    fi

    node_arch="$(detect_node_dist_arch)"
    node_url="${NODE_DIST_MIRROR}/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz"
    install_parent="/usr/local/lib/nodejs"
    install_dir="${install_parent}/node-v${node_version}-linux-${node_arch}"
    tmp_archive="$(mktemp)"

    download_with_retry "$node_url" "$tmp_archive"
    $SUDO mkdir -p "$install_parent"
    $SUDO rm -rf "$install_dir"
    $SUDO tar -xJf "$tmp_archive" -C "$install_parent"
    rm -f "$tmp_archive"

    $SUDO ln -sf "${install_dir}/bin/node" "$NODE_BIN"
    $SUDO ln -sf "${install_dir}/bin/npm" "$NPM_BIN"
    $SUDO ln -sf "${install_dir}/bin/npx" "$NPX_BIN"
    hash -r

    success "Installed Node.js $("$NODE_BIN" --version)."
}

install_codex_cli() {
    local node_cmd node_path_dir npm_cmd

    if [ "$INSTALL_CODEX_CLI" != "true" ]; then
        info "Skipping Codex CLI installation."
        return
    fi

    ensure_nodejs_for_code_server
    node_cmd="$(preferred_node_command || true)"
    npm_cmd="$(preferred_npm_command || true)"
    if [ -z "$node_cmd" ] || [ -z "$npm_cmd" ]; then
        error "Node.js and npm are required to install Codex CLI."
        exit 1
    fi

    node_path_dir="$(dirname "$node_cmd")"
    info "Installing ${CODEX_CLI_PACKAGE} from npm registry ${NPM_REGISTRY}..."
    if ! $SUDO env \
        PATH="${node_path_dir}:/usr/local/bin:${PATH}" \
        npm_config_fetch_retries=5 \
        npm_config_fetch_retry_factor=2 \
        npm_config_fetch_retry_maxtimeout=120000 \
        npm_config_fetch_retry_mintimeout=10000 \
        npm_config_loglevel="$NPM_LOGLEVEL" \
        npm_config_registry="$NPM_REGISTRY" \
        "$npm_cmd" install -g "$CODEX_CLI_PACKAGE" \
            --loglevel="$NPM_LOGLEVEL" \
            --unsafe-perm; then
        error "Failed to install ${CODEX_CLI_PACKAGE}."
        exit 1
    fi

    if ! env PATH="${node_path_dir}:/usr/local/bin:${PATH}" codex --version >/dev/null 2>&1; then
        error "Codex CLI installation failed; 'codex' command is unavailable."
        exit 1
    fi

    success "Installed Codex CLI $(env PATH="${node_path_dir}:/usr/local/bin:${PATH}" codex --version)."
}

install_ttyd() {
    info "Installing ttyd..."
    run_apt apt-get install -y --no-install-recommends ttyd
    stop_and_disable_ttyd_service
}

stop_and_disable_ttyd_service() {
    if [ "$DISABLE_TTYD_SERVICE" != "true" ]; then
        return
    fi

    if ! command -v systemctl >/dev/null 2>&1; then
        return
    fi

    info "Stopping and disabling ttyd.service; this installer only installs tools."
    $SUDO systemctl stop ttyd.service 2>/dev/null || true
    $SUDO systemctl disable ttyd.service 2>/dev/null || true
}

install_code_server() {
    info "Installing code-server..."
    case "$CODE_SERVER_INSTALL_METHOD" in
        deb)
            install_code_server_from_deb
            ;;
        npm)
            install_code_server_from_npm
            ;;
        official)
            install_code_server_from_official_script
            ;;
        auto)
            install_code_server_from_deb || install_code_server_from_npm || install_code_server_from_official_script
            ;;
        *)
            error "Unsupported CODE_SERVER_INSTALL_METHOD=${CODE_SERVER_INSTALL_METHOD}. Use deb, npm, official, or auto."
            exit 1
            ;;
    esac
}

detect_deb_arch() {
    local arch
    arch="$(dpkg --print-architecture)"

    case "$arch" in
        amd64 | arm64)
            printf '%s' "$arch"
            ;;
        *)
            error "Unsupported Debian architecture for code-server deb install: ${arch}"
            return 1
            ;;
    esac
}

append_code_server_deb_urls() {
    local version="$1"
    local arch="$2"
    local base_url="https://github.com/coder/code-server/releases/download/v${version}/code-server_${version}_${arch}.deb"
    local proxy_prefix

    CODE_SERVER_DEB_URLS_BUILT=()
    # shellcheck disable=SC2086
    for proxy_prefix in $CODE_SERVER_DEB_PROXY_PREFIXES; do
        if [ -n "$proxy_prefix" ]; then
            CODE_SERVER_DEB_URLS_BUILT+=("${proxy_prefix}${base_url}")
        fi
    done
    CODE_SERVER_DEB_URLS_BUILT+=("$base_url")
}

install_code_server_from_deb() {
    local arch deb_path version

    version="$(resolve_code_server_version)"
    if [ -z "$version" ]; then
        error "Failed to resolve code-server version."
        return 1
    fi

    arch="$(detect_deb_arch)"
    deb_path="$(mktemp --suffix=.deb)"
    append_code_server_deb_urls "$version" "$arch"

    info "Installing code-server ${version} from prebuilt deb package..."
    if ! download_first_available "$deb_path" "${CODE_SERVER_DEB_URLS_BUILT[@]}"; then
        rm -f "$deb_path"
        return 1
    fi

    run_apt apt-get install -y "$deb_path"
    rm -f "$deb_path"

    if [ -x /usr/bin/code-server ]; then
        $SUDO ln -sf /usr/bin/code-server /usr/local/bin/code-server
    fi
}

install_code_server_from_npm() {
    local node_cmd node_major node_path_dir npm_cmd
    ensure_nodejs_for_code_server
    node_cmd="$(preferred_node_command || true)"
    npm_cmd="$(preferred_npm_command || true)"
    if [ -z "$node_cmd" ] || [ -z "$npm_cmd" ]; then
        error "Node.js and npm are required to install code-server."
        return 1
    fi

    node_major="$("$node_cmd" --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$node_major" -ne "$NODE_MAJOR" ]; then
        error "code-server requires Node.js ${NODE_MAJOR}.x but ${node_cmd} is $("$node_cmd" --version)."
        error "Set NODE_BIN to the Node.js ${NODE_MAJOR}.x binary, then rerun."
        return 1
    fi

    node_path_dir="$(dirname "$node_cmd")"
    info "Using Node.js $("${node_cmd}" --version) at ${node_cmd}."
    info "Installing code-server@${CODE_SERVER_VERSION} from npm registry ${NPM_REGISTRY}..."
    if ! $SUDO env \
        PATH="${node_path_dir}:/usr/local/bin:${PATH}" \
        npm_config_fetch_retries=5 \
        npm_config_fetch_retry_factor=2 \
        npm_config_fetch_retry_maxtimeout=120000 \
        npm_config_fetch_retry_mintimeout=10000 \
        npm_config_foreground_scripts=true \
        npm_config_loglevel="$NPM_LOGLEVEL" \
        npm_config_progress=true \
        npm_config_registry="$NPM_REGISTRY" \
        "$npm_cmd" install -g "code-server@${CODE_SERVER_VERSION}" \
            --foreground-scripts \
            --loglevel="$NPM_LOGLEVEL" \
            --unsafe-perm; then
        return 1
    fi
    link_code_server_binary
}

patch_code_server_vsda_assets() {
    local vscode_roots=()
    local npm_cmd npm_root root

    if [ -d /usr/lib/code-server/lib/vscode ]; then
        vscode_roots+=("/usr/lib/code-server/lib/vscode")
    fi

    npm_cmd="$(preferred_npm_command || true)"
    if [ -n "$npm_cmd" ]; then
        npm_root="$($SUDO env PATH="/usr/local/bin:${PATH}" "$npm_cmd" root -g 2>/dev/null || true)"
        if [ -n "$npm_root" ] && [ -d "${npm_root}/code-server/lib/vscode" ]; then
            vscode_roots+=("${npm_root}/code-server/lib/vscode")
        fi
    fi

    if [ "${#vscode_roots[@]}" -eq 0 ]; then
        error "Cannot find code-server VS Code runtime under /usr/lib or npm global root."
        exit 1
    fi

    for root in "${vscode_roots[@]}"; do
        patch_vsda_runtime "$root"
    done
}

ensure_nodejs_for_code_server() {
    local current_major
    current_major="$(current_node_major || true)"
    if [ -n "$current_major" ] && [ "$current_major" -eq "$NODE_MAJOR" ]; then
        return
    fi

    install_nodejs_from_npmmirror
}

link_code_server_binary() {
    local npm_cmd npm_prefix code_server_bin
    npm_cmd="$(preferred_npm_command || true)"
    if [ -z "$npm_cmd" ]; then
        error "npm is required to locate the code-server executable."
        return 1
    fi

    npm_prefix="$($SUDO env PATH="/usr/local/bin:${PATH}" "$npm_cmd" prefix -g 2>/dev/null || true)"

    if command -v code-server >/dev/null 2>&1; then
        return
    fi

    code_server_bin="${npm_prefix}/bin/code-server"
    if [ -n "$npm_prefix" ] && [ -x "$code_server_bin" ]; then
        $SUDO ln -sf "$code_server_bin" /usr/local/bin/code-server
        return
    fi

    error "code-server was installed by npm, but its executable could not be found."
    return 1
}

install_code_server_from_official_script() {
    tmp_install_script="$(mktemp)"
    # shellcheck disable=SC2086
    download_first_available "$tmp_install_script" $CODE_SERVER_INSTALL_URLS
    $SUDO sh "$tmp_install_script"
    rm -f "$tmp_install_script"
}

patch_vsda_runtime() {
    local vscode_root="$1"
    local vsda_root="${vscode_root}/node_modules/vsda"
    local vsda_dir="${vsda_root}/rust/web"

    info "Applying code-server vsda compatibility patch under ${vscode_root}..."
    $SUDO mkdir -p "$vsda_dir"

    printf '%s\n' \
        '{"name":"vsda","version":"0.0.0","main":"index.js"}' \
        | $SUDO tee "${vsda_root}/package.json" >/dev/null

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
        | $SUDO tee "${vsda_root}/index.js" >/dev/null

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
        | $SUDO tee "${vsda_dir}/vsda.js" >/dev/null

    $SUDO touch "${vsda_dir}/vsda_bg.wasm"
}

run_with_timeout() {
    local timeout_seconds="$1"
    local elapsed=0
    local pid
    shift

    "$@" &
    pid="$!"

    while kill -0 "$pid" 2>/dev/null; do
        if [ "$elapsed" -ge "$timeout_seconds" ]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            return 124
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done

    wait "$pid"
}

resolve_code_server_user() {
    if [ -n "$CODE_SERVER_USER" ]; then
        printf '%s' "$CODE_SERVER_USER"
        return
    fi

    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER:-}" != "root" ]; then
        printf '%s' "$SUDO_USER"
        return
    fi

    id -un
}

resolve_user_home() {
    local user="$1"
    local home_dir

    home_dir="$(getent passwd "$user" | cut -d: -f6)"
    if [ -z "$home_dir" ]; then
        error "Cannot resolve home directory for user ${user}."
        return 1
    fi

    printf '%s' "$home_dir"
}

resolve_code_server_extensions_dir() {
    local target_home="$1"

    if [ -n "$CODE_SERVER_EXTENSIONS_DIR" ]; then
        printf '%s' "$CODE_SERVER_EXTENSIONS_DIR"
        return
    fi

    printf '%s/.local/share/code-server/extensions' "$target_home"
}

resolve_code_server_config_dir() {
    local target_home="$1"

    if [ -n "$CODE_SERVER_CONFIG_DIR" ]; then
        printf '%s' "$CODE_SERVER_CONFIG_DIR"
        return
    fi

    printf '%s/.config/code-server' "$target_home"
}

run_code_server_as_user() {
    local target_user="$1"
    local target_home="$2"
    shift 2

    if [ "$(id -un)" = "$target_user" ]; then
        HOME="$target_home" code-server "$@"
        return
    fi

    if command -v sudo >/dev/null 2>&1; then
        sudo -H -u "$target_user" env HOME="$target_home" code-server "$@"
        return
    fi

    runuser -u "$target_user" -- env HOME="$target_home" code-server "$@"
}

configure_code_server_auth() {
    local config_dir config_file target_home target_user tmp_config

    target_user="$(resolve_code_server_user)"
    target_home="$(resolve_user_home "$target_user")"
    config_dir="$(resolve_code_server_config_dir "$target_home")"
    config_file="${config_dir}/config.yaml"
    tmp_config="$(mktemp)"

    info "Writing code-server config for user ${target_user} at ${config_file}."
    printf 'bind-addr: %s\nauth: %s\npassword: %s\ncert: false\n' \
        "$CODE_SERVER_BIND_ADDR" \
        "$CODE_SERVER_AUTH" \
        "$CODE_SERVER_PASSWORD" \
        >"$tmp_config"

    $SUDO mkdir -p "$config_dir"
    $SUDO cp "$tmp_config" "$config_file"
    rm -f "$tmp_config"
    $SUDO chown -R "${target_user}:" "$config_dir"
    $SUDO chmod 600 "$config_file"
}

install_wecoder_agent_extension() {
    local extension_source="$WECODER_AGENT_EXTENSION_ID"
    local target_extensions_dir target_home target_user

    if [ "$INSTALL_WECODER_AGENT" != "true" ]; then
        info "Skipping Wecoder Agent extension installation."
        return
    fi

    if ! command -v code-server >/dev/null 2>&1; then
        error "code-server command is unavailable; cannot install ${WECODER_AGENT_EXTENSION_ID}."
        return 1
    fi

    target_user="$(resolve_code_server_user)"
    target_home="$(resolve_user_home "$target_user")"
    target_extensions_dir="$(resolve_code_server_extensions_dir "$target_home")"
    $SUDO mkdir -p "$target_extensions_dir"
    $SUDO chown -R "${target_user}:" "$(dirname "$target_extensions_dir")"

    info "Using code-server extensions dir ${target_extensions_dir} for user ${target_user}."

    if run_code_server_as_user "$target_user" "$target_home" \
        --extensions-dir "$target_extensions_dir" \
        --list-extensions 2>/dev/null | grep -Fxq "$WECODER_AGENT_EXTENSION_ID"; then
        info "code-server extension ${WECODER_AGENT_EXTENSION_ID} is already installed."
        return
    fi

    if [ -n "$WECODER_AGENT_VSIX" ]; then
        if [ ! -f "$WECODER_AGENT_VSIX" ]; then
            error "WECODER_AGENT_VSIX does not exist: ${WECODER_AGENT_VSIX}"
            return 1
        fi
        extension_source="$WECODER_AGENT_VSIX"
    fi

    info "Installing code-server extension ${extension_source}..."
    if run_with_timeout \
        "$WECODER_AGENT_INSTALL_TIMEOUT_SECONDS" \
        run_code_server_as_user "$target_user" "$target_home" \
            --extensions-dir "$target_extensions_dir" \
            --install-extension "$extension_source" --force; then
        if run_code_server_as_user "$target_user" "$target_home" \
            --extensions-dir "$target_extensions_dir" \
            --list-extensions 2>/dev/null | grep -Fxq "$WECODER_AGENT_EXTENSION_ID"; then
            return
        fi
    fi

    if [ "$WECODER_AGENT_REQUIRED" = "true" ] || [ -n "$WECODER_AGENT_VSIX" ]; then
        error "Failed to install code-server extension ${extension_source}."
        return 1
    fi

    info "Warning: failed to install ${WECODER_AGENT_EXTENSION_ID}. Set WECODER_AGENT_VSIX=/path/to/wecoder-agent.vsix for offline installation."
}

print_versions() {
    local target_extensions_dir target_home target_user

    success "Installation complete."
    printf '\nInstalled versions:\n'
    ttyd --version || true
    code-server --version || true
    target_user="$(resolve_code_server_user)"
    target_home="$(resolve_user_home "$target_user" 2>/dev/null || true)"
    if [ -n "$target_home" ]; then
        target_extensions_dir="$(resolve_code_server_extensions_dir "$target_home")"
        run_code_server_as_user "$target_user" "$target_home" \
            --extensions-dir "$target_extensions_dir" \
            --list-extensions 2>/dev/null | grep -Fx "$WECODER_AGENT_EXTENSION_ID" || true
    fi
    if command -v node >/dev/null 2>&1; then
        node --version || true
    fi
    if command -v codex >/dev/null 2>&1; then
        codex --version || true
    fi
}

main() {
    require_ubuntu
    configure_sudo
    apt_install_base_packages
    enable_universe_repository
    install_nodejs_if_requested
    install_codex_cli
    install_ttyd
    install_code_server
    patch_code_server_vsda_assets
    configure_code_server_auth
    install_wecoder_agent_extension
    run_apt apt-get clean
    $SUDO rm -rf /var/lib/apt/lists/*
    print_versions
}

main "$@"
