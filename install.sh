#!/usr/bin/env bash
set -euo pipefail

# Wegent Installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash

# Colors
BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MUTED='\033[38;2;90;100;128m'
NC='\033[0m' # No Color

# Configuration
DEPLOY_MODE="${WEGENT_DEPLOY_MODE:-}"
INSTALL_DIR="${WEGENT_INSTALL_DIR:-.}"
IS_SOURCE_BUILD="${WEGENT_SOURCE_BUILD:-}"
NO_PROMPT="${WEGENT_NO_PROMPT:-0}"
VERBOSE="${WEGENT_VERBOSE:-0}"
DRY_RUN="${WEGENT_DRY_RUN:-0}"
SHOW_HELP=0

# Access URL (set during configuration, used in completion message)
ACCESS_HOST="localhost"
SOCKET_URL="http://localhost:8000"

# URLs for downloading compose files (standard mode only)
COMPOSE_URL="https://raw.githubusercontent.com/wecode-ai/Wegent/main/docker-compose.yml"

# Standalone mode configuration (uses docker run, no compose needed)
STANDALONE_IMAGE="${WEGENT_STANDALONE_IMAGE:-ghcr.io/wecode-ai/wegent-standalone:latest}"
STANDALONE_CONTAINER_NAME="wegent-standalone"
STANDALONE_VOLUME_NAME="wegent-data"
STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"
STANDALONE_EXECUTOR_MODE="${WEGENT_STANDALONE_EXECUTOR_MODE:-}"
HOST_EXECUTOR_INSTALL_URL="${WEGENT_HOST_EXECUTOR_INSTALL_URL:-https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh}"
HOST_EXECUTOR_BINARY="${WEGENT_HOST_EXECUTOR_BINARY:-$HOME/.wegent-executor/bin/wegent-executor}"
HOST_EXECUTOR_HOME="${WEGENT_HOST_EXECUTOR_HOME:-$HOME/.wegent-executor}"
HOST_EXECUTOR_PID_FILE="${HOST_EXECUTOR_HOME}/wegent-executor.pid"
HOST_EXECUTOR_LOG_FILE="${HOST_EXECUTOR_HOME}/logs/standalone-host-executor.log"

# Temporary files cleanup
TMPFILES=()
cleanup_tmpfiles() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup_tmpfiles EXIT

mktempfile() {
    local f
    f="$(mktemp)"
    TMPFILES+=("$f")
    echo "$f"
}

# ============================================================================
# UI Functions
# ============================================================================

ui_info() {
    echo -e "${MUTED}·${NC} $*"
}

ui_success() {
    echo -e "${GREEN}✓${NC} $*"
}

ui_warn() {
    echo -e "${YELLOW}!${NC} $*"
}

ui_error() {
    echo -e "${RED}✗${NC} $*"
}

ui_section() {
    echo ""
    echo -e "${CYAN}${BOLD}$1${NC}"
}

ui_kv() {
    local key="$1"
    local value="$2"
    printf "${MUTED}%-20s${NC} %s\n" "$key:" "$value"
}

print_banner() {
    echo -e "${BLUE}${BOLD}"
    cat << 'EOF'
 __        __                    _
 \ \      / /__  __ _  ___ _ __ | |_
  \ \ /\ / / _ \/ _` |/ _ \ '_ \| __|
   \ V  V /  __/ (_| |  __/ | | | |_
    \_/\_/ \___|\__, |\___|_| |_|\__|
                |___/
EOF
    echo -e "${NC}"
    echo -e "${GREEN}${BOLD}Wegent Installer${NC}"
    echo -e "${MUTED}AI-native operating system for intelligent agent teams${NC}"
    echo ""
}

print_usage() {
    cat <<EOF
Wegent Installer (macOS + Linux)

Usage:
  curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- [options]

Options:
  --standalone          Install in standalone mode (single container, recommended)
  --standard            Install in standard mode (multi-container with MySQL)
  --executor-mode MODE  Standalone executor mode: container, host, or hybrid
  --no-prompt           Disable interactive prompts (for CI/automation)
  --dry-run             Print what would happen without making changes
  --verbose             Enable verbose output
  --help, -h            Show this help message

Environment variables:
  WEGENT_DEPLOY_MODE    Set to 'standalone' or 'standard'
  WEGENT_INSTALL_DIR    Installation directory (default: current directory)
  WEGENT_SOURCE_BUILD   Set to '1' to force source build mode
  WEGENT_NO_PROMPT      Set to '1' to disable prompts
  WEGENT_VERBOSE        Set to '1' for verbose output
  WEGENT_DRY_RUN        Set to '1' for dry run
  WEGENT_STANDALONE_IMAGE  Custom standalone image (default: ghcr.io/wecode-ai/wegent-standalone:latest)
  WEGENT_STANDALONE_EXECUTOR_MODE  Set standalone executor mode: container, host, or hybrid

Examples:
  # Interactive installation (recommended)
  curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash

  # Non-interactive standalone installation
  curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --standalone --no-prompt

  # Install to specific directory
  WEGENT_INSTALL_DIR=/opt/wegent curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
EOF
}

# ============================================================================
# Argument Parsing
# ============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --standalone)
                DEPLOY_MODE="standalone"
                shift
                ;;
            --standard)
                DEPLOY_MODE="standard"
                shift
                ;;
            --executor-mode)
                if [[ $# -lt 2 ]]; then
                    ui_error "--executor-mode requires a value: container, host, or hybrid"
                    exit 1
                fi
                STANDALONE_EXECUTOR_MODE="$2"
                shift 2
                ;;
            --no-prompt)
                NO_PROMPT=1
                shift
                ;;
            --dry-run)
                DRY_RUN=1
                shift
                ;;
            --verbose)
                VERBOSE=1
                shift
                ;;
            --help|-h)
                SHOW_HELP=1
                shift
                ;;
            *)
                shift
                ;;
        esac
    done
}

# ============================================================================
# OS Detection
# ============================================================================

OS="unknown"
ARCH="unknown"

detect_os() {
    case "$(uname -s 2>/dev/null || true)" in
        Darwin)
            OS="macos"
            ;;
        Linux)
            OS="linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            OS="windows"
            ;;
    esac

    case "$(uname -m 2>/dev/null || true)" in
        x86_64|amd64)
            ARCH="x86_64"
            ;;
        arm64|aarch64)
            ARCH="arm64"
            ;;
        armv7l|armv7)
            ARCH="armv7"
            ;;
    esac
}

# ============================================================================
# Utility Functions
# ============================================================================

is_root() {
    [[ "$(id -u)" -eq 0 ]]
}

is_promptable() {
    if [[ "$NO_PROMPT" == "1" ]]; then
        return 1
    fi
    # Check if /dev/tty is available (works even with curl | bash)
    if [[ -e /dev/tty ]]; then
        return 0
    fi
    # Fallback: check if stdin/stdout are terminals
    if [[ -t 0 && -t 1 ]]; then
        return 0
    fi
    return 1
}

command_exists() {
    command -v "$1" &> /dev/null
}

read_env_value() {
    local key="$1"
    local env_file="$2"

    if [[ ! -f "$env_file" ]]; then
        return
    fi

    awk -F= -v target="$key" '
        $1 == target {
            sub(/^[^=]*=/, "")
            print
            exit
        }
    ' "$env_file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^["'"'"']//;s/["'"'"']$//'
}

generate_internal_service_token() {
    if command_exists openssl; then
        openssl rand -hex 32
        return
    fi

    if command_exists python3; then
        python3 - <<'PY'
import secrets

print(secrets.token_hex(32))
PY
        return
    fi

    echo ""
}

persist_internal_service_token() {
    local token="$1"
    local env_file=".env"
    local temp_file
    temp_file="$(mktempfile)"

    if [[ -f "$env_file" ]]; then
        grep -v "^INTERNAL_SERVICE_TOKEN=" "$env_file" > "$temp_file" || true
    else
        cat > "$temp_file" <<EOF
# Wegent Configuration
# Generated by install.sh on $(date)
EOF
    fi

    cat >> "$temp_file" <<EOF

# Internal service authentication token shared by Wegent services.
# Generated automatically by install.sh.
INTERNAL_SERVICE_TOKEN=${token}
EOF

    mv "$temp_file" "$env_file"
}

ensure_internal_service_token() {
    local existing_token
    existing_token="$(read_env_value "INTERNAL_SERVICE_TOKEN" ".env")"

    if [[ -n "$existing_token" ]]; then
        export INTERNAL_SERVICE_TOKEN="$existing_token"
        return
    fi

    local token="${INTERNAL_SERVICE_TOKEN:-}"
    if [[ -z "$token" ]]; then
        token="$(generate_internal_service_token)"
        if [[ -z "$token" ]]; then
            ui_error "Unable to generate INTERNAL_SERVICE_TOKEN. Install openssl or python3, or set INTERNAL_SERVICE_TOKEN manually."
            exit 1
        fi
        ui_success "Generated INTERNAL_SERVICE_TOKEN and saved it to .env"
    fi

    export INTERNAL_SERVICE_TOKEN="$token"
    persist_internal_service_token "$token"
}

run_quiet_step() {
    local title="$1"
    shift

    if [[ "$VERBOSE" == "1" ]]; then
        echo -e "${MUTED}Running: $*${NC}"
        "$@"
        return $?
    fi

    local log
    log="$(mktempfile)"

    # Show spinner while command is running
    local spinner_chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local spinner_pid=""

    # Start spinner in background
    (
        local i=0
        local len=${#spinner_chars}
        while true; do
            printf "\r${MUTED}%s${NC} %s..." "${spinner_chars:$i:1}" "$title"
            i=$(( (i + 1) % len ))
            sleep 0.1
        done
    ) &
    spinner_pid=$!

    # Run the actual command
    local exit_code=0
    if "$@" >"$log" 2>&1; then
        exit_code=0
    else
        exit_code=$?
    fi

    # Stop spinner
    kill "$spinner_pid" 2>/dev/null || true
    wait "$spinner_pid" 2>/dev/null || true

    # Clear spinner line
    printf "\r\033[K"

    if [[ $exit_code -eq 0 ]]; then
        ui_success "$title"
        return 0
    fi

    ui_error "${title} failed"
    if [[ -s "$log" ]]; then
        echo ""
        echo -e "${MUTED}--- Error output ---${NC}"
        tail -n 30 "$log" >&2 || true
        echo -e "${MUTED}--- End of output ---${NC}"
    fi
    return 1
}

# ============================================================================
# Docker Installation
# ============================================================================

check_docker() {
    if command_exists docker; then
        ui_success "Docker found"
        return 0
    fi
    return 1
}

check_docker_running() {
    if docker info &> /dev/null; then
        ui_success "Docker daemon is running"
        return 0
    fi
    return 1
}

check_docker_compose() {
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
        ui_success "Docker Compose (plugin) found"
        return 0
    elif command_exists docker-compose; then
        COMPOSE_CMD="docker-compose"
        ui_success "Docker Compose (standalone) found"
        return 0
    fi
    return 1
}

install_docker_macos() {
    ui_section "Installing Docker on macOS"

    # Check if Homebrew is available
    if ! command_exists brew; then
        ui_info "Homebrew not found, installing..."
        if [[ "$DRY_RUN" == "1" ]]; then
            ui_info "[DRY RUN] Would install Homebrew"
        else
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            # Add Homebrew to PATH for this session
            if [[ -f "/opt/homebrew/bin/brew" ]]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [[ -f "/usr/local/bin/brew" ]]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
        fi
        ui_success "Homebrew installed"
    else
        ui_success "Homebrew already installed"
    fi

    # Install Docker Desktop via Homebrew Cask
    ui_info "Installing Docker Desktop via Homebrew..."
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would run: brew install --cask docker"
    else
        if ! run_quiet_step "Installing Docker Desktop" brew install --cask docker; then
            ui_error "Failed to install Docker Desktop"
            echo ""
            echo "You can manually install Docker Desktop from:"
            echo "  https://www.docker.com/products/docker-desktop/"
            return 1
        fi
    fi

    ui_success "Docker Desktop installed"
    echo ""
    ui_warn "Please start Docker Desktop manually:"
    echo "  1. Open Docker Desktop from Applications"
    echo "  2. Wait for Docker to start (whale icon in menu bar)"
    echo "  3. Re-run this installer"
    echo ""

    if is_promptable; then
        echo -e "${YELLOW}Press Enter after Docker Desktop is running...${NC}"
        read -r < /dev/tty
        if check_docker_running; then
            return 0
        fi
    fi

    return 1
}

install_docker_linux() {
    ui_section "Installing Docker on Linux"

    # Detect Linux distribution
    local distro=""
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        distro="${ID:-}"
    fi

    ui_info "Detected distribution: ${distro:-unknown}"

    case "$distro" in
        ubuntu|debian|linuxmint|pop)
            install_docker_debian
            ;;
        fedora|rhel|centos|rocky|almalinux)
            install_docker_rhel
            ;;
        arch|manjaro)
            install_docker_arch
            ;;
        *)
            install_docker_generic
            ;;
    esac
}

install_docker_debian() {
    ui_info "Installing Docker using official Docker repository..."
    ui_info "This may take a few minutes, please wait..."

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would install Docker via apt"
        return 0
    fi

    local sudo_cmd=""
    if ! is_root; then
        sudo_cmd="sudo"
    fi

    # Remove old versions (ignore errors if packages don't exist)
    ui_info "Removing old Docker versions..."
    $sudo_cmd apt-get remove -y docker docker-engine docker.io containerd runc >/dev/null 2>&1 || true
    ui_success "Old Docker versions removed"

    # Install prerequisites
    run_quiet_step "Updating package index" $sudo_cmd apt-get update
    run_quiet_step "Installing prerequisites" $sudo_cmd apt-get install -y \
        ca-certificates \
        curl \
        gnupg \
        lsb-release

    # Add Docker's official GPG key
    ui_info "Adding Docker GPG key..."
    $sudo_cmd install -m 0755 -d /etc/apt/keyrings
    $sudo_cmd rm -f /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $sudo_cmd gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    $sudo_cmd chmod a+r /etc/apt/keyrings/docker.gpg
    ui_success "Docker GPG key added"

    # Set up the repository
    ui_info "Setting up Docker repository..."
    local arch
    arch="$(dpkg --print-architecture)"
    local codename
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-$(lsb_release -cs)}")"

    echo \
        "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
        ${codename} stable" | $sudo_cmd tee /etc/apt/sources.list.d/docker.list > /dev/null
    ui_success "Docker repository configured"

    # Install Docker Engine
    run_quiet_step "Updating package index" $sudo_cmd apt-get update
    run_quiet_step "Installing Docker Engine (this may take a while)" $sudo_cmd apt-get install -y \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    # Add current user to docker group
    if ! is_root; then
        $sudo_cmd usermod -aG docker "$USER" 2>/dev/null || true
        ui_info "Added $USER to docker group"
    fi

    # Start Docker service
    run_quiet_step "Starting Docker service" $sudo_cmd systemctl enable docker 2>/dev/null || true
    run_quiet_step "Starting Docker service" $sudo_cmd systemctl start docker 2>/dev/null || true

    ui_success "Docker installed successfully"
}

install_docker_rhel() {
    ui_info "Installing Docker using official Docker repository..."
    ui_info "This may take a few minutes, please wait..."

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would install Docker via dnf/yum"
        return 0
    fi

    local sudo_cmd=""
    if ! is_root; then
        sudo_cmd="sudo"
    fi

    local pkg_manager="dnf"
    if ! command_exists dnf; then
        pkg_manager="yum"
    fi

    # Remove old versions (ignore errors if packages don't exist)
    ui_info "Removing old Docker versions..."
    $sudo_cmd $pkg_manager remove -y docker docker-client docker-client-latest \
        docker-common docker-latest docker-latest-logrotate \
        docker-logrotate docker-engine >/dev/null 2>&1 || true
    ui_success "Old Docker versions removed"

    # Install prerequisites
    run_quiet_step "Installing prerequisites" $sudo_cmd $pkg_manager install -y yum-utils

    # Add Docker repository
    ui_info "Adding Docker repository..."
    $sudo_cmd yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || \
    $sudo_cmd yum-config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo 2>/dev/null || true
    ui_success "Docker repository added"

    # Install Docker Engine
    run_quiet_step "Installing Docker Engine (this may take a while)" $sudo_cmd $pkg_manager install -y \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    # Add current user to docker group
    if ! is_root; then
        $sudo_cmd usermod -aG docker "$USER" 2>/dev/null || true
        ui_info "Added $USER to docker group"
    fi

    # Start Docker service
    run_quiet_step "Starting Docker service" $sudo_cmd systemctl enable docker 2>/dev/null || true
    run_quiet_step "Starting Docker service" $sudo_cmd systemctl start docker 2>/dev/null || true

    ui_success "Docker installed successfully"
}

install_docker_arch() {
    ui_info "Installing Docker via pacman..."
    ui_info "This may take a few minutes, please wait..."

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would install Docker via pacman"
        return 0
    fi

    local sudo_cmd=""
    if ! is_root; then
        sudo_cmd="sudo"
    fi

    run_quiet_step "Installing Docker (this may take a while)" $sudo_cmd pacman -S --noconfirm docker docker-compose

    # Add current user to docker group
    if ! is_root; then
        $sudo_cmd usermod -aG docker "$USER" 2>/dev/null || true
        ui_info "Added $USER to docker group"
    fi

    # Start Docker service
    run_quiet_step "Starting Docker service" $sudo_cmd systemctl enable docker 2>/dev/null || true
    run_quiet_step "Starting Docker service" $sudo_cmd systemctl start docker 2>/dev/null || true

    ui_success "Docker installed successfully"
}

install_docker_generic() {
    ui_info "Installing Docker using convenience script..."
    ui_info "This may take a few minutes, please wait..."

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would install Docker via get.docker.com"
        return 0
    fi

    ui_info "Downloading Docker installation script..."
    local tmp
    tmp="$(mktempfile)"
    curl -fsSL https://get.docker.com -o "$tmp"
    ui_success "Docker installation script downloaded"

    if is_root; then
        run_quiet_step "Installing Docker (this may take a while)" sh "$tmp"
    else
        run_quiet_step "Installing Docker (this may take a while)" sudo sh "$tmp"
    fi

    # Add current user to docker group
    if ! is_root; then
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        ui_info "Added $USER to docker group"
    fi

    ui_success "Docker installed successfully"
}

ensure_docker() {
    ui_section "[1/4] Checking Docker"

    # Check if Docker is installed
    if ! check_docker; then
        ui_info "Docker not found, installing..."

        if [[ "$OS" == "macos" ]]; then
            if ! install_docker_macos; then
                ui_error "Docker installation failed or Docker is not running"
                echo ""
                echo "Please install Docker Desktop manually:"
                echo "  https://www.docker.com/products/docker-desktop/"
                exit 1
            fi
        elif [[ "$OS" == "linux" ]]; then
            if ! install_docker_linux; then
                ui_error "Docker installation failed"
                echo ""
                echo "Please install Docker manually:"
                echo "  https://docs.docker.com/engine/install/"
                exit 1
            fi
        else
            ui_error "Unsupported operating system: $OS"
            echo "Please install Docker manually:"
            echo "  https://docs.docker.com/get-docker/"
            exit 1
        fi
    fi

    # Check if Docker daemon is running
    if ! check_docker_running; then
        ui_warn "Docker daemon is not running"
        echo ""
        if [[ "$OS" == "macos" ]]; then
            echo "Please start Docker Desktop:"
            echo "  1. Open Docker Desktop from Applications"
            echo "  2. Wait for Docker to start (whale icon in menu bar)"
        else
            echo "Please start Docker:"
            echo "  sudo systemctl start docker"
        fi
        echo ""

        if is_promptable; then
            echo -e "${YELLOW}Press Enter after Docker is running...${NC}"
            read -r < /dev/tty
            if ! check_docker_running; then
                ui_error "Docker daemon is still not running"
                exit 1
            fi
        else
            exit 1
        fi
    fi

    # Check Docker Compose (only needed for standard mode)
    if [[ "$DEPLOY_MODE" != "standalone" ]]; then
        if ! check_docker_compose; then
            ui_error "Docker Compose is not available"
            echo ""
            echo "Docker Compose should be included with Docker Desktop."
            echo "If using Docker Engine, install the compose plugin:"
            echo "  sudo apt-get install docker-compose-plugin"
            exit 1
        fi
    else
        # For standalone mode, we don't need compose but still check if available for info
        if docker compose version &> /dev/null; then
            COMPOSE_CMD="docker compose"
        elif command_exists docker-compose; then
            COMPOSE_CMD="docker-compose"
        fi
        ui_success "Standalone mode: Docker Compose not required"
    fi
}

# ============================================================================
# Source Build Detection
# ============================================================================

detect_source_build() {
    if [[ -n "$IS_SOURCE_BUILD" ]]; then
        return
    fi

    # Check if we are in a git repository AND have the build configuration file
    if git rev-parse --git-dir > /dev/null 2>&1 && [[ -f "docker-compose.build.yml" ]]; then
        IS_SOURCE_BUILD=1
    else
        IS_SOURCE_BUILD=0
    fi
}

# ============================================================================
# Deployment Mode Selection
# ============================================================================

select_deploy_mode() {
    ui_section "[2/4] Selecting Deployment Mode"

    if [[ -n "$DEPLOY_MODE" ]]; then
        if [[ "$DEPLOY_MODE" == "standalone" ]]; then
            ui_success "Using Standalone mode (from argument/env)"
        else
            ui_success "Using Standard mode (from argument/env)"
        fi
        return
    fi

    if ! is_promptable; then
        DEPLOY_MODE="standalone"
        ui_info "Non-interactive mode, defaulting to Standalone"
        return
    fi

    echo ""
    echo -e "${YELLOW}Select deployment mode:${NC}"
    echo -e "  ${GREEN}[1]${NC} Standalone mode ${MUTED}(recommended)${NC}"
    echo -e "      Single container, SQLite, easy setup, low resource usage"
    echo ""
    echo -e "  ${BLUE}[2]${NC} Standard mode"
    echo -e "      Multi-container, MySQL, production-ready, scalable"
    echo ""
    printf "Choose [1/2] (default: 1): "
    read -r mode_choice < /dev/tty

    case "$mode_choice" in
        2)
            DEPLOY_MODE="standard"
            ui_success "Selected Standard mode"
            ;;
        *)
            DEPLOY_MODE="standalone"
            ui_success "Selected Standalone mode"
            ;;
    esac
}

is_valid_standalone_executor_mode() {
    case "$1" in
        container|host|hybrid)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

default_standalone_executor_mode() {
    if [[ "$NO_PROMPT" == "1" ]]; then
        echo "container"
        return
    fi

    if [[ "$OS" == "macos" ]]; then
        echo "host"
        return
    fi

    echo "container"
}

select_standalone_executor_mode() {
    if [[ "$DEPLOY_MODE" != "standalone" ]]; then
        if [[ -n "$STANDALONE_EXECUTOR_MODE" ]]; then
            ui_warn "--executor-mode applies only to standalone mode; ignoring '$STANDALONE_EXECUTOR_MODE'"
        fi
        return
    fi

    if [[ -z "$STANDALONE_EXECUTOR_MODE" && -n "${WEGENT_STANDALONE_EXECUTOR_MODE:-}" ]]; then
        STANDALONE_EXECUTOR_MODE="$WEGENT_STANDALONE_EXECUTOR_MODE"
    fi

    if [[ -n "$STANDALONE_EXECUTOR_MODE" ]]; then
        if ! is_valid_standalone_executor_mode "$STANDALONE_EXECUTOR_MODE"; then
            ui_error "Invalid standalone executor mode: $STANDALONE_EXECUTOR_MODE"
            ui_info "Accepted values: container, host, hybrid"
            return 1
        fi
        ui_success "Using standalone executor mode: $STANDALONE_EXECUTOR_MODE"
        return
    fi

    if ! is_promptable; then
        STANDALONE_EXECUTOR_MODE="container"
        ui_info "Non-interactive mode, using standalone executor mode: $STANDALONE_EXECUTOR_MODE"
        return
    fi

    local default_mode
    default_mode="$(default_standalone_executor_mode)"

    echo ""
    echo -e "${YELLOW}Select standalone executor mode:${NC}"
    echo -e "  ${GREEN}[1]${NC} Host executor ${MUTED}(recommended on macOS)${NC}"
    echo -e "      Runs coding agents on this machine; required for macOS system commands"
    echo ""
    echo -e "  ${BLUE}[2]${NC} Container executor"
    echo -e "      Current standalone behavior; everything runs inside Docker"
    echo ""
    echo -e "  ${CYAN}[3]${NC} Hybrid"
    echo -e "      Start both container and host executors"
    echo ""

    local default_choice="2"
    if [[ "$default_mode" == "host" ]]; then
        default_choice="1"
    elif [[ "$default_mode" == "hybrid" ]]; then
        default_choice="3"
    fi

    printf "Choose [1/2/3] (default: %s): " "$default_choice"
    local executor_choice
    read -r executor_choice < /dev/tty
    executor_choice="${executor_choice:-$default_choice}"

    case "$executor_choice" in
        1)
            STANDALONE_EXECUTOR_MODE="host"
            ;;
        3)
            STANDALONE_EXECUTOR_MODE="hybrid"
            ;;
        *)
            STANDALONE_EXECUTOR_MODE="container"
            ;;
    esac

    ui_success "Selected standalone executor mode: $STANDALONE_EXECUTOR_MODE"
}

standalone_container_executor_enabled() {
    case "$STANDALONE_EXECUTOR_MODE" in
        host)
            echo "false"
            ;;
        container|hybrid)
            echo "true"
            ;;
        *)
            echo "true"
            ;;
    esac
}

needs_host_executor() {
    [[ "$DEPLOY_MODE" == "standalone" ]] || return 1
    [[ "$STANDALONE_EXECUTOR_MODE" == "host" || "$STANDALONE_EXECUTOR_MODE" == "hybrid" ]]
}

install_host_executor_from_release() {
    ui_section "Installing Host Executor"

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would download and run: ${HOST_EXECUTOR_INSTALL_URL}"
        return
    fi

    ui_info "Downloading executor release installer..."
    if ! curl -fsSL "$HOST_EXECUTOR_INSTALL_URL" | bash; then
        ui_error "Failed to install host executor from release"
        ui_info "Retry manually:"
        ui_info "  curl -fsSL ${HOST_EXECUTOR_INSTALL_URL} | bash"
        return 1
    fi
}

read_standalone_executor_token() {
    docker exec "$STANDALONE_CONTAINER_NAME" sh -lc 'cat /app/data/standalone_executor_token'
}

redact_token() {
    local token="$1"
    if [[ ${#token} -le 10 ]]; then
        echo "redacted"
        return
    fi
    printf '%s...\n' "${token:0:10}"
}

host_executor_device_name() {
    local os_label="Host"
    case "$OS" in
        macos)
            os_label="macOS"
            ;;
        linux)
            os_label="Linux"
            ;;
    esac

    printf '%s-%s\n' "$(hostname)" "$os_label"
}

configure_host_executor() {
    local token="$1"
    local config_path="${HOST_EXECUTOR_HOME}/device-config.json"

    mkdir -p "$HOST_EXECUTOR_HOME"
    umask 077
    cat > "$config_path" <<EOF
{
  "mode": "local",
  "device_type": "local",
  "bind_shell": "claudecode",
  "device_id": "",
  "device_name": "$(host_executor_device_name)",
  "capabilities": [],
  "max_concurrent_tasks": 5,
  "connection": {
    "backend_url": "http://127.0.0.1:8000",
    "auth_token": "$token"
  },
  "logging": {
    "level": "info",
    "max_size_mb": 10,
    "backup_count": 5
  },
  "update": {
    "registry": "",
    "registry_token": ""
  }
}
EOF
    chmod 600 "$config_path"
    ui_success "Host executor configured at ${config_path}"
}

stop_host_executor_if_running() {
    if [[ ! -f "$HOST_EXECUTOR_PID_FILE" ]]; then
        return
    fi

    local pid
    pid="$(cat "$HOST_EXECUTOR_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
        ui_info "Stopping existing host executor (PID: $pid)"
        kill "$pid" >/dev/null 2>&1 || true
        for _ in {1..20}; do
            if ! kill -0 "$pid" >/dev/null 2>&1; then
                break
            fi
            sleep 0.5
        done
    fi
    rm -f "$HOST_EXECUTOR_PID_FILE"
}

start_host_executor() {
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would start host executor: ${HOST_EXECUTOR_BINARY}"
        return
    fi

    if [[ ! -x "$HOST_EXECUTOR_BINARY" ]]; then
        ui_error "Host executor binary is missing or not executable: ${HOST_EXECUTOR_BINARY}"
        return 1
    fi

    mkdir -p "$(dirname "$HOST_EXECUTOR_LOG_FILE")"
    stop_host_executor_if_running

    ui_info "Starting host executor..."
    WEGENT_EXECUTOR_HOME="$HOST_EXECUTOR_HOME" \
        LOCAL_WORKSPACE_ROOT="${HOST_EXECUTOR_HOME}/workspace" \
        nohup "$HOST_EXECUTOR_BINARY" >> "$HOST_EXECUTOR_LOG_FILE" 2>&1 &
    echo $! > "$HOST_EXECUTOR_PID_FILE"
    sleep 1

    if ! kill -0 "$(cat "$HOST_EXECUTOR_PID_FILE")" >/dev/null 2>&1; then
        ui_error "Host executor failed to start"
        ui_info "Recent log:"
        tail -n 80 "$HOST_EXECUTOR_LOG_FILE" || true
        return 1
    fi

    ui_success "Host executor started with PID $(cat "$HOST_EXECUTOR_PID_FILE")"
}

setup_host_executor_if_needed() {
    if ! needs_host_executor; then
        return
    fi

    install_host_executor_from_release

    if [[ "$DRY_RUN" == "1" ]]; then
        return
    fi

    local token
    if ! token="$(read_standalone_executor_token)"; then
        ui_error "Failed to read standalone executor token"
        ui_info "Check container logs: docker logs ${STANDALONE_CONTAINER_NAME}"
        return 1
    fi

    if [[ -z "$token" ]]; then
        ui_error "Standalone executor token is empty"
        ui_info "Check container logs: docker logs ${STANDALONE_CONTAINER_NAME}"
        return 1
    fi

    ui_info "Using standalone executor token: $(redact_token "$token")"
    configure_host_executor "$token"
    start_host_executor
}

# ============================================================================
# Configuration
# ============================================================================

# Detect server IP for WebSocket configuration
detect_server_ip() {
    local ip=""

    if [[ "$OS" == "macos" ]]; then
        # macOS: use ipconfig or ifconfig
        for iface in en0 en1 en2 en3; do
            ip=$(ipconfig getifaddr "$iface" 2>/dev/null)
            if [[ -n "$ip" && "$ip" != "127.0.0.1" ]]; then
                echo "$ip"
                return
            fi
        done
        # Fallback: use ifconfig
        ip=$(ifconfig 2>/dev/null | awk '/inet / && !/127.0.0.1/ {print $2; exit}')
        if [[ -n "$ip" ]]; then
            echo "$ip"
            return
        fi
    else
        # Linux: use ip command or hostname -I
        for iface in eth0 ens33 ens160 enp0s3 enp0s8 ens192 em1; do
            ip=$(ip -4 addr show "$iface" 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]}' | head -1)
            if [[ -n "$ip" ]]; then
                echo "$ip"
                return
            fi
        done
        # Fallback: hostname -I
        ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.\(1[6-9]\|2[0-9]\|3[0-1]\)\.' | grep -v '^127\.' | head -1)
        if [[ -n "$ip" ]]; then
            echo "$ip"
            return
        fi
        # Last resort: ip route
        ip=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
        if [[ -n "$ip" ]]; then
            echo "$ip"
            return
        fi
    fi

    echo ""
}

configure_environment() {
    ui_section "[3/4] Configuring Environment"

    local server_ip
    server_ip=$(detect_server_ip)
    SOCKET_URL="http://localhost:8000"

    if [[ -n "$server_ip" && "$server_ip" != "127.0.0.1" ]] && is_promptable; then
        echo ""
        echo -e "${YELLOW}Detected server IP: ${GREEN}${server_ip}${NC}"
        echo "Use this IP for WebSocket connection (for remote access)?"
        echo -e "  ${GREEN}[Y]${NC} Yes, use ${server_ip}"
        echo -e "  ${YELLOW}[n]${NC} No, use localhost (local development)"
        echo -e "  ${BLUE}[c]${NC} Custom IP or domain"
        printf "Choose [Y/n/c]: "
        read -r choice < /dev/tty

        case "$choice" in
            n|N)
                SOCKET_URL="http://localhost:8000"
                ACCESS_HOST="localhost"
                ;;
            c|C)
                printf "Enter custom address (e.g., example.com): "
                read -r custom_host < /dev/tty
                SOCKET_URL="http://${custom_host}:8000"
                ACCESS_HOST="${custom_host}"
                ;;
            *)
                SOCKET_URL="http://${server_ip}:8000"
                ACCESS_HOST="${server_ip}"
                ;;
        esac
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would configure RUNTIME_SOCKET_DIRECT_URL=${SOCKET_URL}"
        return
    fi

    # For standard mode, create .env file
    if [[ "$DEPLOY_MODE" != "standalone" ]]; then
        if [[ ! -f ".env" ]]; then
            cat > .env <<EOF
# Wegent Configuration
# Generated by install.sh on $(date)

# WebSocket URL for frontend to connect to backend
# This is read by the frontend at runtime via /runtime-config API
RUNTIME_SOCKET_DIRECT_URL=${SOCKET_URL}
EOF
            ensure_internal_service_token
            ui_success "Configuration saved to .env"
        else
            ensure_internal_service_token
            ui_success "Found existing .env file, configuration ready"
        fi
    else
        ui_success "Standalone mode: configuration will be passed via docker run"
    fi
}

# ============================================================================
# Download and Start (Standard Mode)
# ============================================================================

download_compose_files() {
    # Only needed for standard mode
    if [[ "$DEPLOY_MODE" == "standalone" ]]; then
        return
    fi

    if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
        ui_success "Detected source code (git clone), using local files"

        if [[ ! -f "docker-compose.yml" ]]; then
            ui_error "docker-compose.yml not found"
            exit 1
        fi
        if [[ ! -f "docker-compose.build.yml" ]]; then
            ui_error "docker-compose.build.yml not found"
            exit 1
        fi
    else
        ui_info "Downloading docker-compose.yml..."
        if [[ "$DRY_RUN" == "1" ]]; then
            ui_info "[DRY RUN] Would download from $COMPOSE_URL"
        else
            if ! curl -fsSL "$COMPOSE_URL" -o docker-compose.yml; then
                ui_error "Failed to download docker-compose.yml"
                exit 1
            fi
        fi
    fi
}

start_standard_services() {
    # Build compose command
    local compose_args=""
    if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
        compose_args="-f docker-compose.yml -f docker-compose.build.yml"
    else
        compose_args="-f docker-compose.yml"
    fi

    ui_info "Starting Wegent services..."

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would run: $COMPOSE_CMD $compose_args up -d"
        return
    fi

    if ! $COMPOSE_CMD $compose_args up -d; then
        ui_error "Failed to start services"
        echo ""
        echo "Check the logs for more details:"
        echo "  $COMPOSE_CMD $compose_args logs"
        exit 1
    fi

    ui_success "Wegent services started"
}

# ============================================================================
# Standalone Mode (docker run)
# ============================================================================

start_standalone_service() {
    ui_section "[4/4] Starting Wegent (Standalone)"

    # Check if container already exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${STANDALONE_CONTAINER_NAME}$"; then
        ui_warn "Container '${STANDALONE_CONTAINER_NAME}' already exists"
        
        # Check if it's running
        if docker ps --format '{{.Names}}' | grep -q "^${STANDALONE_CONTAINER_NAME}$"; then
            ui_info "Container is already running"
            if is_promptable; then
                echo ""
                echo -e "${YELLOW}What would you like to do?${NC}"
                echo -e "  ${GREEN}[1]${NC} Keep running (do nothing)"
                echo -e "  ${YELLOW}[2]${NC} Restart container"
                echo -e "  ${RED}[3]${NC} Remove and recreate"
                printf "Choose [1/2/3] (default: 1): "
                read -r action_choice < /dev/tty
                
                case "$action_choice" in
                    2)
                        ui_info "Restarting container..."
                        docker restart "${STANDALONE_CONTAINER_NAME}"
                        ui_success "Container restarted"
                        return
                        ;;
                    3)
                        ui_info "Removing existing container..."
                        docker rm -f "${STANDALONE_CONTAINER_NAME}"
                        ui_success "Container removed"
                        ;;
                    *)
                        ui_success "Keeping existing container"
                        return
                        ;;
                esac
            else
                ui_success "Container is already running, skipping"
                return
            fi
        else
            ui_info "Container exists but is not running, removing..."
            docker rm "${STANDALONE_CONTAINER_NAME}"
            ui_success "Container removed"
        fi
    fi

    # Pull the latest image
    ui_info "Pulling Wegent standalone image..."
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would run: docker pull ${STANDALONE_IMAGE}"
    else
        if ! run_quiet_step "Pulling image" docker pull "${STANDALONE_IMAGE}"; then
            ui_warn "Failed to pull image, will try to use local image if available"
        fi
    fi

    # Create volume if it doesn't exist
    if ! docker volume ls --format '{{.Name}}' | grep -q "^${STANDALONE_VOLUME_NAME}$"; then
        ui_info "Creating data volume..."
        if [[ "$DRY_RUN" != "1" ]]; then
            docker volume create "${STANDALONE_VOLUME_NAME}"
        fi
        ui_success "Data volume created"
    else
        ui_success "Data volume already exists"
    fi

    # Create workspace volume if it doesn't exist
    if ! docker volume ls --format '{{.Name}}' | grep -q "^${STANDALONE_WORKSPACE_VOLUME_NAME}$"; then
        ui_info "Creating workspace volume..."
        if [[ "$DRY_RUN" != "1" ]]; then
            docker volume create "${STANDALONE_WORKSPACE_VOLUME_NAME}"
        fi
        ui_success "Workspace volume created"
    else
        ui_success "Workspace volume already exists"
    fi

    # Build docker run command
    local docker_run_cmd="docker run -d"
    docker_run_cmd+=" --name ${STANDALONE_CONTAINER_NAME}"
    docker_run_cmd+=" --restart unless-stopped"
    docker_run_cmd+=" -p 3000:3000"
    docker_run_cmd+=" -p 3001:3001"
    docker_run_cmd+=" -p 8000:8000"
    docker_run_cmd+=" -v ${STANDALONE_VOLUME_NAME}:/app/data"
    docker_run_cmd+=" -v ${STANDALONE_WORKSPACE_VOLUME_NAME}:/workspace"
    docker_run_cmd+=" -e RUNTIME_SOCKET_DIRECT_URL=${SOCKET_URL}"
    docker_run_cmd+=" -e RUNTIME_WEWORK_CODE_URL=http://${ACCESS_HOST}:3001"
    docker_run_cmd+=" -e WEWORK_PUBLIC_BACKEND_URL=${SOCKET_URL}"
    docker_run_cmd+=" -e STANDALONE_EXECUTOR_ENABLED=$(standalone_container_executor_enabled)"
    docker_run_cmd+=" -e LITELLM_LOCAL_MODEL_COST_MAP=True"
    docker_run_cmd+=" ${STANDALONE_IMAGE}"

    ui_info "Starting Wegent container..."
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would run: ${docker_run_cmd}"
        return
    fi

    if ! eval "${docker_run_cmd}"; then
        ui_error "Failed to start container"
        echo ""
        echo "Check Docker logs for more details:"
        echo "  docker logs ${STANDALONE_CONTAINER_NAME}"
        exit 1
    fi

    ui_success "Wegent container started"
}

# ============================================================================
# Wait for Services
# ============================================================================

wait_for_standalone_service() {
    local max_wait=120
    local health_url="http://localhost:8000/health"
    local wework_url="http://localhost:3001/"

    echo ""
    ui_info "Waiting for services to be ready (this may take 30-90 seconds)..."
    echo ""

    # Phase 1: Wait for container to be running
    echo -ne "  ${MUTED}[1/4]${NC} Starting container..."
    local phase1_max=30
    local phase1_elapsed=0

    while [[ $phase1_elapsed -lt $phase1_max ]]; do
        if docker ps --format '{{.Names}}' | grep -q "^${STANDALONE_CONTAINER_NAME}$"; then
            echo -e "\r  ${GREEN}✓${NC} [1/4] Container started                      "
            break
        fi
        sleep 2
        phase1_elapsed=$((phase1_elapsed + 2))
        local dots=$(( (phase1_elapsed / 2) % 4 ))
        local dot_str=""
        for ((i=0; i<dots; i++)); do dot_str+="."; done
        echo -ne "\r  ${MUTED}[1/4]${NC} Starting container${dot_str}   "
    done

    if [[ $phase1_elapsed -ge $phase1_max ]]; then
        echo -e "\r  ${YELLOW}!${NC} [1/4] Container starting (continuing...)     "
    fi

    # Phase 2: Database initialization
    echo -e "  ${GREEN}✓${NC} [2/4] Database initialized (SQLite + Redis)  "

    # Phase 3: Wait for health endpoint
    echo -ne "  ${MUTED}[3/4]${NC} Checking backend health..."
    local phase3_max=60
    local phase3_elapsed=0

    while [[ $phase3_elapsed -lt $phase3_max ]]; do
        if curl -fsSL --connect-timeout 2 --max-time 5 "$health_url" >/dev/null 2>&1; then
            echo -e "\r  ${GREEN}✓${NC} [3/4] Backend health check passed            "
            break
        fi

        sleep 3
        phase3_elapsed=$((phase3_elapsed + 3))
        local dots=$(( (phase3_elapsed / 3) % 4 ))
        local dot_str=""
        for ((i=0; i<dots; i++)); do dot_str+="."; done
        echo -ne "\r  ${MUTED}[3/4]${NC} Checking backend health${dot_str}   "
    done

    if [[ $phase3_elapsed -ge $phase3_max ]]; then
        echo -e "\r  ${YELLOW}!${NC} [3/4] Backend health check pending          "
        echo ""
        ui_warn "Services may not be fully ready yet (timeout after ${max_wait}s)"
        ui_info "The services are still starting in the background."
        ui_info "You can check the status with: docker logs ${STANDALONE_CONTAINER_NAME}"
        return 0
    fi

    # Phase 4: Wait for Wework endpoint
    echo -ne "  ${MUTED}[4/4]${NC} Checking Wework..."
    local phase4_max=60
    local phase4_elapsed=0

    while [[ $phase4_elapsed -lt $phase4_max ]]; do
        if curl -fsSL --connect-timeout 2 --max-time 5 "$wework_url" >/dev/null 2>&1; then
            echo -e "\r  ${GREEN}✓${NC} [4/4] Wework is ready                    "
            echo ""
            ui_success "All services are ready!"
            return 0
        fi

        sleep 3
        phase4_elapsed=$((phase4_elapsed + 3))
        local dots=$(( (phase4_elapsed / 3) % 4 ))
        local dot_str=""
        for ((i=0; i<dots; i++)); do dot_str+="."; done
        echo -ne "\r  ${MUTED}[4/4]${NC} Checking Wework${dot_str}   "
    done

    echo -e "\r  ${YELLOW}!${NC} [4/4] Wework or terminal check pending        "
    echo ""
    ui_warn "Services may not be fully ready yet (timeout after ${max_wait}s)"
    ui_info "The services are still starting in the background."
    ui_info "You can check the status with: docker logs ${STANDALONE_CONTAINER_NAME}"
    return 0
}

wait_for_standard_services() {
    local compose_args="$1"
    local max_wait=120
    local health_url="http://localhost:8000/health"

    echo ""
    ui_info "Waiting for services to be ready (this may take 30-60 seconds)..."
    echo ""

    # Phase 1: Wait for containers to start
    local phase1_max=30
    local phase1_elapsed=0
    echo -ne "  ${MUTED}[1/3]${NC} Starting containers..."

    while [[ $phase1_elapsed -lt $phase1_max ]]; do
        local container_status
        container_status=$($COMPOSE_CMD $compose_args ps --format json 2>/dev/null | head -1)
        if [[ -n "$container_status" ]]; then
            echo -e "\r  ${GREEN}✓${NC} [1/3] Containers started                    "
            break
        fi
        sleep 2
        phase1_elapsed=$((phase1_elapsed + 2))
        local dots=$(( (phase1_elapsed / 2) % 4 ))
        local dot_str=""
        for ((i=0; i<dots; i++)); do dot_str+="."; done
        echo -ne "\r  ${MUTED}[1/3]${NC} Starting containers${dot_str}   "
    done

    if [[ $phase1_elapsed -ge $phase1_max ]]; then
        echo -e "\r  ${YELLOW}!${NC} [1/3] Containers starting (continuing...)    "
    fi

    # Phase 2: Wait for database initialization
    echo -ne "  ${MUTED}[2/3]${NC} Initializing database..."
    local phase2_max=40
    local phase2_elapsed=0

    while [[ $phase2_elapsed -lt $phase2_max ]]; do
        if $COMPOSE_CMD $compose_args logs backend 2>/dev/null | grep -q "Application startup complete\|Uvicorn running"; then
            echo -e "\r  ${GREEN}✓${NC} [2/3] Database initialized                   "
            break
        fi
        sleep 3
        phase2_elapsed=$((phase2_elapsed + 3))
        local dots=$(( (phase2_elapsed / 3) % 4 ))
        local dot_str=""
        for ((i=0; i<dots; i++)); do dot_str+="."; done
        echo -ne "\r  ${MUTED}[2/3]${NC} Initializing database${dot_str}   "
    done

    if [[ $phase2_elapsed -ge $phase2_max ]]; then
        echo -e "\r  ${YELLOW}!${NC} [2/3] Database initializing (continuing...)  "
    fi

    # Phase 3: Wait for health endpoint
    echo -ne "  ${MUTED}[3/3]${NC} Checking service health..."
    local phase3_max=50
    local phase3_elapsed=0

    while [[ $phase3_elapsed -lt $phase3_max ]]; do
        if curl -fsSL --connect-timeout 2 --max-time 5 "$health_url" >/dev/null 2>&1; then
            echo -e "\r  ${GREEN}✓${NC} [3/3] Service health check passed            "
            echo ""
            ui_success "All services are ready!"
            return 0
        fi

        sleep 3
        phase3_elapsed=$((phase3_elapsed + 3))
        local dots=$(( (phase3_elapsed / 3) % 4 ))
        local dot_str=""
        for ((i=0; i<dots; i++)); do dot_str+="."; done
        echo -ne "\r  ${MUTED}[3/3]${NC} Checking service health${dot_str}   "
    done

    echo -e "\r  ${YELLOW}!${NC} [3/3] Health check pending                   "
    echo ""
    ui_warn "Services may not be fully ready yet (timeout after ${max_wait}s)"
    ui_info "The services are still starting in the background."
    ui_info "You can check the status with: $COMPOSE_CMD $compose_args ps"
    ui_info "View logs with: $COMPOSE_CMD $compose_args logs -f"
    return 0
}

# ============================================================================
# Completion
# ============================================================================

print_completion() {
    echo ""
    echo -e "${GREEN}${BOLD}========================================${NC}"
    echo -e "${GREEN}${BOLD}  Wegent installed successfully! 🎉${NC}"
    echo -e "${GREEN}${BOLD}========================================${NC}"
    echo ""
    echo -e "  Open ${BLUE}${BOLD}http://${ACCESS_HOST}:3000${NC} in your browser"
    if [[ "$DEPLOY_MODE" == "standalone" ]]; then
        echo -e "  Open ${BLUE}${BOLD}http://${ACCESS_HOST}:3001${NC} for Wework"
    fi
    echo ""
    ui_kv "Deployment mode" "$DEPLOY_MODE"
    ui_kv "Access URL" "http://${ACCESS_HOST}:3000"

    if [[ "$DEPLOY_MODE" == "standalone" ]]; then
        ui_kv "Wework URL" "http://${ACCESS_HOST}:3001"
        ui_kv "Terminal access" "Wework workspace terminal"
        ui_kv "Executor mode" "$STANDALONE_EXECUTOR_MODE"
        if [[ "$STANDALONE_EXECUTOR_MODE" == "host" || "$STANDALONE_EXECUTOR_MODE" == "hybrid" ]]; then
            ui_kv "Host executor" "$HOST_EXECUTOR_BINARY"
        fi
        ui_kv "Container name" "$STANDALONE_CONTAINER_NAME"
        ui_kv "Data volume" "$STANDALONE_VOLUME_NAME"
        ui_kv "Workspace volume" "$STANDALONE_WORKSPACE_VOLUME_NAME"
    else
        ui_kv "Installation directory" "$(pwd)"
        if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
            ui_kv "Build mode" "source"
        fi
    fi

    echo ""
    echo -e "${CYAN}Useful commands:${NC}"
    echo ""

    if [[ "$DEPLOY_MODE" == "standalone" ]]; then
        echo -e "  ${MUTED}# View logs${NC}"
        echo -e "  ${YELLOW}docker logs -f ${STANDALONE_CONTAINER_NAME}${NC}"
        echo ""
        echo -e "  ${MUTED}# Stop service${NC}"
        echo -e "  ${YELLOW}docker stop ${STANDALONE_CONTAINER_NAME}${NC}"
        echo ""
        echo -e "  ${MUTED}# Start service${NC}"
        echo -e "  ${YELLOW}docker start ${STANDALONE_CONTAINER_NAME}${NC}"
        echo ""
        echo -e "  ${MUTED}# Restart service${NC}"
        echo -e "  ${YELLOW}docker restart ${STANDALONE_CONTAINER_NAME}${NC}"
        echo ""
        echo -e "  ${MUTED}# Remove container (data is preserved in volume)${NC}"
        echo -e "  ${YELLOW}docker rm -f ${STANDALONE_CONTAINER_NAME}${NC}"
        echo ""
        echo -e "  ${MUTED}# Update to latest version${NC}"
        echo -e "  ${YELLOW}docker pull ${STANDALONE_IMAGE} && docker rm -f ${STANDALONE_CONTAINER_NAME} && \\"
        echo -e "  docker run -d --name ${STANDALONE_CONTAINER_NAME} --restart unless-stopped \\"
        echo -e "    -p 3000:3000 -p 3001:3001 -p 8000:8000 \\"
        echo -e "    -v ${STANDALONE_VOLUME_NAME}:/app/data -v ${STANDALONE_WORKSPACE_VOLUME_NAME}:/workspace \\"
        echo -e "    -e RUNTIME_SOCKET_DIRECT_URL=${SOCKET_URL} -e RUNTIME_WEWORK_CODE_URL=http://${ACCESS_HOST}:3001 \\"
        echo -e "    -e WEWORK_PUBLIC_BACKEND_URL=${SOCKET_URL} \\"
        echo -e "    -e STANDALONE_EXECUTOR_ENABLED=$(standalone_container_executor_enabled) \\"
        echo -e "    ${STANDALONE_IMAGE}${NC}"
    else
        local compose_args=""
        if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
            compose_args="-f docker-compose.yml -f docker-compose.build.yml"
        else
            compose_args="-f docker-compose.yml"
        fi

        echo -e "  ${MUTED}# View logs${NC}"
        echo -e "  ${YELLOW}$COMPOSE_CMD $compose_args logs -f${NC}"
        echo ""
        echo -e "  ${MUTED}# Stop services${NC}"
        echo -e "  ${YELLOW}$COMPOSE_CMD $compose_args down${NC}"
        echo ""
        echo -e "  ${MUTED}# Start services${NC}"
        echo -e "  ${YELLOW}$COMPOSE_CMD $compose_args up -d${NC}"

        if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
            echo ""
            echo -e "  ${MUTED}# Rebuild images${NC}"
            echo -e "  ${YELLOW}$COMPOSE_CMD $compose_args build --no-cache${NC}"
        fi
    fi

    echo ""

    # Check if user needs to re-login for docker group
    if [[ "$OS" == "linux" ]] && ! is_root; then
        if ! groups | grep -q docker; then
            echo -e "${YELLOW}Note:${NC} You may need to log out and back in for docker group changes to take effect."
            echo ""
        fi
    fi
}

# ============================================================================
# Main
# ============================================================================

main() {
    parse_args "$@"

    if [[ "$SHOW_HELP" == "1" ]]; then
        print_usage
        exit 0
    fi

    print_banner

    # Detect OS
    detect_os
    if [[ "$OS" == "unknown" ]]; then
        ui_error "Unsupported operating system"
        echo "This installer supports macOS and Linux."
        echo "For Windows, please use Docker Desktop and run:"
        echo "  docker run -d --name wegent-standalone \\"
        echo "    -p 3000:3000 -p 3001:3001 -p 8000:8000 \\"
        echo "    -v wegent-data:/app/data -v wegent-workspace:/workspace \\"
        echo "    -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000 -e RUNTIME_WEWORK_CODE_URL=http://localhost:3001 \\"
        echo "    -e WEWORK_PUBLIC_BACKEND_URL=http://localhost:8000 \\"
        echo "    ghcr.io/wecode-ai/wegent-standalone:latest"
        exit 1
    fi
    ui_success "Detected: $OS ($ARCH)"

    # Check curl
    if ! command_exists curl; then
        ui_error "curl is required but not installed"
        exit 1
    fi

    # Create and enter install directory (only for standard mode)
    if [[ "$INSTALL_DIR" != "." ]] && [[ "$DEPLOY_MODE" != "standalone" ]]; then
        ui_info "Installing to $INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    # Detect source build
    detect_source_build
    if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
        ui_success "Detected Wegent source code (git clone)"
        ui_info "Will build images from source code"
    fi

    # Show install plan in verbose mode
    if [[ "$VERBOSE" == "1" ]]; then
        ui_section "Install Plan"
        ui_kv "OS" "$OS"
        ui_kv "Architecture" "$ARCH"
        ui_kv "Deploy mode" "${DEPLOY_MODE:-auto}"
        ui_kv "Install directory" "$(pwd)"
        ui_kv "Source build" "$IS_SOURCE_BUILD"
        ui_kv "Dry run" "$DRY_RUN"
    fi

    # Main installation steps
    # Step 2: Select deployment mode (before ensure_docker so we know if compose is needed)
    select_deploy_mode
    select_standalone_executor_mode
    
    # Step 1: Ensure Docker is available
    ensure_docker
    
    # Step 3: Configure environment
    configure_environment

    # Step 4: Start services based on mode
    if [[ "$DEPLOY_MODE" == "standalone" ]]; then
        start_standalone_service
        
        # Wait for services to be ready
        if [[ "$DRY_RUN" != "1" ]]; then
            wait_for_standalone_service
            setup_host_executor_if_needed
        else
            setup_host_executor_if_needed
        fi
    else
        ui_section "[4/4] Starting Wegent (Standard)"
        download_compose_files
        start_standard_services
        
        # Wait for services to be ready
        if [[ "$DRY_RUN" != "1" ]]; then
            local compose_args=""
            if [[ "$IS_SOURCE_BUILD" == "1" ]]; then
                compose_args="-f docker-compose.yml -f docker-compose.build.yml"
            else
                compose_args="-f docker-compose.yml"
            fi
            wait_for_standard_services "$compose_args"
        fi
    fi

    print_completion
}

# Run main function
main "$@"
