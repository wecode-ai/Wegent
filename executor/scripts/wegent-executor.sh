#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Wegent Local Executor - Installer & Launcher
# This script installs and manages the wegent-executor binary

set -e

# Configuration
WEGENT_EXECUTOR_HOME="${WEGENT_EXECUTOR_HOME:-$HOME/.wegent-executor}"
BINARY_NAME="wegent-executor"
BINARY_PATH="${WEGENT_EXECUTOR_HOME}/bin/${BINARY_NAME}"
CONFIG_FILE="${WEGENT_EXECUTOR_HOME}/config.env"
PID_FILE="${WEGENT_EXECUTOR_HOME}/executor.pid"
LOG_FILE="${WEGENT_EXECUTOR_HOME}/logs/executor.log"
GITHUB_REPO="wecode-ai/Wegent"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ============================================================
# Installation Functions
# ============================================================

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        darwin) OS="darwin" ;;
        linux) OS="linux" ;;
        mingw*|msys*|cygwin*) OS="windows" ;;
        *) error "Unsupported operating system: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64) ARCH="amd64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac

    PLATFORM="${OS}-${ARCH}"
    info "Detected platform: $PLATFORM"
}

get_latest_version() {
    info "Fetching latest release version..."

    if command -v curl &> /dev/null; then
        LATEST_VERSION=$(curl -s "${GITHUB_API}/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    elif command -v wget &> /dev/null; then
        LATEST_VERSION=$(wget -qO- "${GITHUB_API}/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

    if [ -z "$LATEST_VERSION" ]; then
        warn "Could not fetch latest version, using 'latest'"
        LATEST_VERSION="latest"
    fi

    info "Latest version: $LATEST_VERSION"
}

get_download_url() {
    # Binary naming: wegent-executor-local-{os}-{arch}
    BINARY_FILENAME="wegent-executor-local-${PLATFORM}"
    if [ "$OS" = "windows" ]; then
        BINARY_FILENAME="${BINARY_FILENAME}.exe"
    fi

    if [ "$LATEST_VERSION" = "latest" ]; then
        DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/${BINARY_FILENAME}"
    else
        DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${LATEST_VERSION}/${BINARY_FILENAME}"
    fi

    info "Download URL: $DOWNLOAD_URL"
}

create_directories() {
    info "Creating directory structure..."

    mkdir -p "${WEGENT_EXECUTOR_HOME}/bin"
    mkdir -p "${WEGENT_EXECUTOR_HOME}/workspace"
    mkdir -p "${WEGENT_EXECUTOR_HOME}/logs"
    mkdir -p "${WEGENT_EXECUTOR_HOME}/cache/skills"

    success "Directory structure created at ${WEGENT_EXECUTOR_HOME}"
}

download_binary() {
    info "Downloading ${BINARY_NAME}..."

    DEST_PATH="${WEGENT_EXECUTOR_HOME}/bin/${BINARY_NAME}"
    if [ "$OS" = "windows" ]; then
        DEST_PATH="${DEST_PATH}.exe"
    fi

    if command -v curl &> /dev/null; then
        curl -fsSL -o "$DEST_PATH" "$DOWNLOAD_URL" || error "Failed to download binary"
    elif command -v wget &> /dev/null; then
        wget -q -O "$DEST_PATH" "$DOWNLOAD_URL" || error "Failed to download binary"
    fi

    if [ "$OS" != "windows" ]; then
        chmod +x "$DEST_PATH"
    fi

    success "Binary downloaded to $DEST_PATH"
}

verify_installation() {
    info "Verifying installation..."

    local binary_path="${WEGENT_EXECUTOR_HOME}/bin/${BINARY_NAME}"
    if [ "$OS" = "windows" ]; then
        binary_path="${binary_path}.exe"
    fi

    if [ -f "$binary_path" ]; then
        FILE_SIZE=$(ls -lh "$binary_path" | awk '{print $5}')
        success "Installation verified. Binary size: $FILE_SIZE"
    else
        error "Installation verification failed. Binary not found."
    fi
}

create_config_template() {
    if [ ! -f "$CONFIG_FILE" ]; then
        info "Creating config template..."
        cat > "$CONFIG_FILE" << 'CONFIGEOF'
# Wegent Local Executor Configuration
# Copy this file and fill in your values

# Required: Backend server URL
WEGENT_BACKEND_URL=http://localhost:8000

# Required: Authentication token (get from Wegent web UI)
WEGENT_AUTH_TOKEN=your-auth-token-here

# Optional: Anthropic API Key (for Claude Code agent)
# ANTHROPIC_API_KEY=your-api-key-here

# Optional: Log level (INFO or DEBUG)
# LOG_LEVEL=INFO

# Optional: Skill cache mode (true = only replace existing skills)
# SKILL_CLEAR_CACHE=true
CONFIGEOF
        success "Config template created at $CONFIG_FILE"
    else
        info "Config file already exists, skipping template creation"
    fi
}

print_install_success() {
    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Wegent Local Executor Installation Complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BLUE}Directory Structure:${NC}"
    echo "  ${WEGENT_EXECUTOR_HOME}/"
    echo "  ├── bin/wegent-executor    # Binary"
    echo "  ├── workspace/             # Task workspace"
    echo "  ├── logs/                  # Log files"
    echo "  ├── cache/skills/          # Skills cache"
    echo "  └── config.env             # Configuration"
    echo ""
    echo -e "${BLUE}Next Steps:${NC}"
    echo ""
    echo "  1. Edit the config file:"
    echo -e "     ${YELLOW}nano ${CONFIG_FILE}${NC}"
    echo ""
    echo "  2. Start the executor:"
    echo -e "     ${YELLOW}$0 start${NC}"
    echo ""
    echo -e "${BLUE}Documentation:${NC}"
    echo "  https://github.com/${GITHUB_REPO}/blob/main/executor/docs/LOCAL_MODE.md"
    echo ""
}

do_install() {
    local version=""

    # Parse install arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -v|--version)
                version="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Wegent Local Executor Installer${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo ""

    detect_platform

    if [ -n "$version" ]; then
        LATEST_VERSION="$version"
        info "Using specified version: $LATEST_VERSION"
    else
        get_latest_version
    fi

    get_download_url
    create_directories
    download_binary
    verify_installation
    create_config_template
    print_install_success
}

# ============================================================
# Launcher Functions
# ============================================================

check_binary() {
    if [ ! -f "$BINARY_PATH" ]; then
        error "Binary not found at $BINARY_PATH\nRun '$0 install' first to download the binary."
    fi
}

load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        info "Loading config from $CONFIG_FILE"
        set -a
        source "$CONFIG_FILE"
        set +a
    else
        warn "Config file not found at $CONFIG_FILE"
    fi

    if [ -z "$WEGENT_BACKEND_URL" ]; then
        error "WEGENT_BACKEND_URL is not set. Please configure $CONFIG_FILE"
    fi

    if [ -z "$WEGENT_AUTH_TOKEN" ] || [ "$WEGENT_AUTH_TOKEN" = "your-auth-token-here" ]; then
        error "WEGENT_AUTH_TOKEN is not set. Please configure $CONFIG_FILE"
    fi
}

check_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            return 0  # Running
        else
            rm -f "$PID_FILE"
        fi
    fi
    return 1  # Not running
}

do_start() {
    check_binary
    load_config

    if check_running; then
        PID=$(cat "$PID_FILE")
        warn "Executor is already running (PID: $PID)"
        echo "Use '$0 stop' to stop it, or '$0 restart' to restart."
        exit 0
    fi

    info "Starting Wegent Local Executor..."
    info "Backend URL: $WEGENT_BACKEND_URL"
    info "Log file: $LOG_FILE"

    # Export required environment variables
    export EXECUTOR_MODE=local
    export WEGENT_BACKEND_URL
    export WEGENT_AUTH_TOKEN
    export WEGENT_EXECUTOR_HOME

    # Optional variables
    [ -n "$ANTHROPIC_API_KEY" ] && export ANTHROPIC_API_KEY
    [ -n "$LOG_LEVEL" ] && export LOG_LEVEL
    [ -n "$SKILL_CLEAR_CACHE" ] && export SKILL_CLEAR_CACHE

    # Ensure log directory exists
    mkdir -p "$(dirname "$LOG_FILE")"

    # Start in background
    nohup "$BINARY_PATH" >> "$LOG_FILE" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"

    sleep 2

    if kill -0 "$PID" 2>/dev/null; then
        success "Executor started (PID: $PID)"
        echo ""
        echo "View logs: tail -f $LOG_FILE"
        echo "Stop: $0 stop"
    else
        error "Failed to start executor. Check logs: $LOG_FILE"
    fi
}

do_stop() {
    if ! check_running; then
        warn "Executor is not running"
        return 0
    fi

    PID=$(cat "$PID_FILE")
    info "Stopping executor (PID: $PID)..."

    kill "$PID" 2>/dev/null || true

    # Wait for graceful shutdown
    for i in {1..10}; do
        if ! kill -0 "$PID" 2>/dev/null; then
            rm -f "$PID_FILE"
            success "Executor stopped"
            return 0
        fi
        sleep 1
    done

    # Force kill if still running
    warn "Force killing executor..."
    kill -9 "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    success "Executor stopped (forced)"
}

do_restart() {
    do_stop
    sleep 1
    do_start
}

do_status() {
    if check_running; then
        PID=$(cat "$PID_FILE")
        success "Executor is running (PID: $PID)"
        echo ""
        echo "Recent logs:"
        tail -5 "$LOG_FILE" 2>/dev/null || echo "No logs available"
    else
        warn "Executor is not running"
    fi
}

do_logs() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        error "Log file not found: $LOG_FILE"
    fi
}

do_run() {
    check_binary
    load_config

    if check_running; then
        PID=$(cat "$PID_FILE")
        error "Executor is already running in background (PID: $PID)\nStop it first: $0 stop"
    fi

    info "Starting Wegent Local Executor in foreground..."
    info "Press Ctrl+C to stop"
    echo ""

    export EXECUTOR_MODE=local
    export WEGENT_BACKEND_URL
    export WEGENT_AUTH_TOKEN
    export WEGENT_EXECUTOR_HOME
    [ -n "$ANTHROPIC_API_KEY" ] && export ANTHROPIC_API_KEY
    [ -n "$LOG_LEVEL" ] && export LOG_LEVEL
    [ -n "$SKILL_CLEAR_CACHE" ] && export SKILL_CLEAR_CACHE

    exec "$BINARY_PATH"
}

# ============================================================
# Main
# ============================================================

usage() {
    echo "Wegent Local Executor - Installer & Launcher"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Installation Commands:"
    echo "  install [-v VERSION]   Download and install the executor binary"
    echo ""
    echo "Runtime Commands:"
    echo "  start     Start the executor in background"
    echo "  stop      Stop the executor"
    echo "  restart   Restart the executor"
    echo "  status    Show executor status"
    echo "  logs      Tail the log file"
    echo "  run       Run in foreground (for debugging)"
    echo ""
    echo "Options:"
    echo "  -v, --version VERSION   Install specific version (e.g., v1.0.0)"
    echo "  -h, --help              Show this help message"
    echo ""
    echo "Configuration:"
    echo "  Edit $CONFIG_FILE"
    echo ""
    echo "Examples:"
    echo "  $0 install              # Install latest version"
    echo "  $0 install -v v1.0.0    # Install specific version"
    echo "  $0 start                # Start executor"
    echo "  $0 logs                 # View logs"
    echo ""
}

case "${1:-}" in
    install)
        shift
        do_install "$@"
        ;;
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    status)
        do_status
        ;;
    logs)
        do_logs
        ;;
    run)
        do_run
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        usage
        exit 1
        ;;
esac
