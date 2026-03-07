#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Constants
REPO_OWNER="wecode-ai"
REPO_NAME="Wegent"
GITHUB_API="https://api.github.com"
GITHUB_RELEASE_URL="${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases"
INSTALL_DIR="${HOME}/.wegent"
BIN_DIR="${INSTALL_DIR}/bin"
CLI_INSTALL_METHOD=""

echo -e "${BLUE}"
cat << 'EOF'
 __        __                    _      ____ _     ___
 \ \      / /__  __ _  ___ _ __ | |_   / ___| |   |_ _|
  \ \ /\ / / _ \/ _` |/ _ \ '_ \| __| | |   | |    | |
   \ V  V /  __/ (_| |  __/ | | | |_  | |___| |___ | |
    \_/\_/ \___|\__, |\___|_| |_|\__|  \____|_____|___|
                |___/
EOF
echo -e "${NC}"
echo -e "${GREEN}Wegent CLI & Executor Installer${NC}"
echo -e "${CYAN}https://github.com/${REPO_OWNER}/${REPO_NAME}${NC}"
echo ""

# Utility functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if command -v "$1" &> /dev/null; then
        return 0
    else
        return 1
    fi
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."

    local missing_cmds=()

    if ! check_command "curl"; then
        missing_cmds+=("curl")
    fi

    if ! check_command "python3"; then
        missing_cmds+=("python3")
    fi

    if ! check_command "git"; then
        missing_cmds+=("git")
    fi

    if [ ${#missing_cmds[@]} -ne 0 ]; then
        log_error "Missing required commands: ${missing_cmds[*]}"
        echo ""
        echo "Please install the missing requirements:"
        echo "  - macOS: brew install ${missing_cmds[*]}"
        echo "  - Ubuntu/Debian: sudo apt-get install ${missing_cmds[*]}"
        echo "  - CentOS/RHEL: sudo yum install ${missing_cmds[*]}"
        exit 1
    fi

    # Check Python version
    local python_version
    python_version=$(python3 --version 2>&1 | awk '{print $2}')
    local major_version
    major_version=$(echo "$python_version" | cut -d. -f1)
    local minor_version
    minor_version=$(echo "$python_version" | cut -d. -f2)

    if [ "$major_version" -lt 3 ] || { [ "$major_version" -eq 3 ] && [ "$minor_version" -lt 10 ]; }; then
        log_error "Python 3.10 or higher is required (found: $python_version)"
        exit 1
    fi

    log_success "All requirements satisfied (Python $python_version)"
}

# Detect platform and architecture
detect_platform() {
    local os
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch
    arch=$(uname -m)

    case "$os" in
        linux)
            OS="linux"
            ;;
        darwin)
            OS="macos"
            ;;
        mingw*|msys*|cygwin*)
            OS="windows"
            ;;
        *)
            log_error "Unsupported operating system: $os"
            exit 1
            ;;
    esac

    case "$arch" in
        x86_64|amd64)
            ARCH="amd64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            log_error "Unsupported architecture: $arch"
            exit 1
            ;;
    esac

    log_info "Detected platform: ${OS}-${ARCH}"
}

# Get latest release version
get_latest_version() {
    log_info "Fetching latest release..."

    local release_data
    release_data=$(curl -fsSL "${GITHUB_RELEASE_URL}/latest" 2>&1)

    if [ $? -ne 0 ]; then
        log_error "Failed to fetch release information from GitHub"
        log_error "Make sure you have internet connection and GitHub is accessible"
        exit 1
    fi

    VERSION=$(echo "$release_data" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/"tag_name": *"\(.*\)"/\1/')

    if [ -z "$VERSION" ]; then
        log_error "Failed to parse release version"
        exit 1
    fi

    log_success "Latest version: ${VERSION}"
}

# Download and install executor binary
install_executor() {
    log_info "Installing executor binary..."

    local asset_name="wegent-executor-${OS}-${ARCH}"
    if [ "$OS" = "windows" ]; then
        asset_name="${asset_name}.exe"
    fi

    local download_url
    download_url=$(curl -fsSL "${GITHUB_RELEASE_URL}/tags/${VERSION}" 2>/dev/null | \
        grep -o "\"browser_download_url\": *\"[^\"]*${asset_name}\"" | \
        sed 's/"browser_download_url": *"\(.*\)"/\1/')

    if [ -z "$download_url" ]; then
        log_error "Executor binary not found for ${OS}-${ARCH}"
        log_warn "Skipping executor installation"
        return 1
    fi

    mkdir -p "$BIN_DIR"

    local bin_path="${BIN_DIR}/wegent-executor"
    if [ "$OS" = "windows" ]; then
        bin_path="${bin_path}.exe"
    fi

    local version_file="${BIN_DIR}/.executor-version"

    # Check if executor is already installed with the same version
    if [ -f "$bin_path" ] && [ -f "$version_file" ]; then
        local installed_version
        installed_version=$(cat "$version_file" 2>/dev/null || echo "")

        if [ "$installed_version" = "$VERSION" ]; then
            log_success "Executor binary already up-to-date (${VERSION})"
            return 0
        else
            log_info "Upgrading executor from ${installed_version} to ${VERSION}..."
        fi
    fi

    log_info "Downloading from: ${download_url}"
    if ! curl -fsSL "$download_url" -o "${bin_path}.tmp"; then
        log_error "Failed to download executor binary"
        return 1
    fi

    chmod +x "${bin_path}.tmp"

    # Backup existing binary if it exists
    if [ -f "$bin_path" ]; then
        mv "$bin_path" "${bin_path}.old"
    fi

    mv "${bin_path}.tmp" "$bin_path"

    # Save version info
    echo "$VERSION" > "$version_file"

    log_success "Executor binary installed to: ${bin_path}"
    log_info "Version: ${VERSION}"
    return 0
}

# Install wegent CLI via pip
install_cli_pip() {
    log_info "Installing wegent CLI via pip..."

    if ! check_command "pip3"; then
        log_error "pip3 is not available"
        return 1
    fi

    # Try to install/upgrade from PyPI
    log_info "Trying to install from PyPI..."
    if pip3 install --upgrade wegent &> /dev/null; then
        CLI_INSTALL_METHOD="pip (PyPI)"
        log_success "wegent CLI installed from PyPI"
        return 0
    fi

    # PyPI failed, try to download wheel from GitHub release
    log_warn "PyPI installation failed, trying GitHub release..."
    local wheel_pattern="wegent-.*-py3-none-any.whl"
    local wheel_url
    wheel_url=$(curl -fsSL "${GITHUB_RELEASE_URL}/tags/${VERSION}" 2>/dev/null | \
        grep -o "\"browser_download_url\": *\"[^\"]*${wheel_pattern}\"" | \
        sed 's/"browser_download_url": *"\(.*\)"/\1/')

    if [ -n "$wheel_url" ]; then
        local temp_wheel="/tmp/wegent-${VERSION}.whl"
        log_info "Downloading wheel from: ${wheel_url}"

        if curl -fsSL "$wheel_url" -o "$temp_wheel" 2>/dev/null; then
            if pip3 install --upgrade "$temp_wheel" &> /dev/null; then
                CLI_INSTALL_METHOD="pip (wheel)"
                log_success "wegent CLI installed from GitHub release wheel"
                rm -f "$temp_wheel"
                return 0
            fi
            rm -f "$temp_wheel"
        fi
    fi

    # Both PyPI and GitHub wheel failed, try to clone and install from source
    log_warn "Wheel installation failed, cloning from GitHub repository..."

    local temp_dir="/tmp/wegent-cli-install-$$"
    mkdir -p "$temp_dir"

    if git clone --depth 1 "https://github.com/${REPO_OWNER}/${REPO_NAME}.git" "$temp_dir" &> /dev/null; then
        if [ -d "$temp_dir/wegent-cli" ]; then
            log_info "Installing from source..."
            if pip3 install "$temp_dir/wegent-cli" &> /dev/null; then
                CLI_INSTALL_METHOD="pip (source)"
                log_success "wegent CLI installed from source"
                rm -rf "$temp_dir"
                return 0
            fi
        fi
        rm -rf "$temp_dir"
    fi

    log_error "All installation methods failed"
    return 1
}

# Install wegent CLI via pipx
install_cli_pipx() {
    log_info "Installing wegent CLI via pipx..."

    if ! check_command "pipx"; then
        log_warn "pipx is not installed"
        return 1
    fi

    # Try to install from PyPI
    if pipx install wegent &> /dev/null; then
        CLI_INSTALL_METHOD="pipx (PyPI)"
        log_success "wegent CLI installed via pipx"
        return 0
    fi

    # Try to upgrade if already installed
    if pipx upgrade wegent &> /dev/null; then
        CLI_INSTALL_METHOD="pipx (PyPI)"
        log_success "wegent CLI upgraded via pipx"
        return 0
    fi

    return 1
}

# Install wegent CLI
install_cli() {
    log_info "Installing wegent CLI..."

    # Try pipx first (better isolation), then fall back to pip
    if check_command "pipx"; then
        if install_cli_pipx; then
            return 0
        fi
    fi

    if install_cli_pip; then
        return 0
    fi

    log_error "Failed to install wegent CLI"
    return 1
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."

    local wegent_path
    wegent_path=$(command -v wegent 2>/dev/null || echo "")

    if [ -z "$wegent_path" ]; then
        log_warn "wegent command not found in PATH"
        log_warn "You may need to restart your shell or add to PATH manually"

        # Show potential PATH locations based on install method
        if [ "$CLI_INSTALL_METHOD" = "pipx" ]; then
            local pipx_bin
            pipx_bin=$(pipx environment --value PIPX_BIN_DIR 2>/dev/null || echo "$HOME/.local/bin")
            echo ""
            echo "Add to PATH by adding this line to your ~/.bashrc or ~/.zshrc:"
            echo -e "  ${YELLOW}export PATH=\"${pipx_bin}:\$PATH\"${NC}"
        elif [ "$CLI_INSTALL_METHOD" = "pip" ]; then
            echo ""
            echo "Add to PATH by adding this line to your ~/.bashrc or ~/.zshrc:"
            echo -e "  ${YELLOW}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
        fi

        return 1
    fi

    local installed_version
    installed_version=$(wegent --version 2>&1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' || echo "unknown")

    log_success "wegent CLI installed: ${wegent_path}"
    log_success "Version: ${installed_version}"

    # Check executor
    local executor_path="${BIN_DIR}/wegent-executor"
    if [ "$OS" = "windows" ]; then
        executor_path="${executor_path}.exe"
    fi

    if [ -f "$executor_path" ]; then
        log_success "Executor binary installed: ${executor_path}"
    else
        log_warn "Executor binary not installed"
    fi

    return 0
}

# Show post-install instructions
show_instructions() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Installation Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    # Ask if user wants to configure and start executor now
    echo -e "${CYAN}Would you like to set up and start the executor now?${NC}"
    echo -e "  ${GREEN}[Y]${NC} Yes, configure and start now (recommended)"
    echo -e "  ${YELLOW}[n]${NC} No, I'll do it later"
    read -r -p "Choose [Y/n]: " setup_choice

    case "$setup_choice" in
        n|N)
            show_manual_instructions
            ;;
        *)
            interactive_setup
            ;;
    esac
}

# Interactive setup: login and start executor
interactive_setup() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  Quick Setup${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""

    # Step 1: Configure server
    echo -e "${CYAN}Step 1: Configure Wegent Server${NC}"
    echo ""
    read -r -p "Enter Wegent server URL [http://localhost:8000]: " server_url
    server_url=${server_url:-http://localhost:8000}

    log_info "Setting server to: ${server_url}"
    wegent config set server "$server_url"

    echo ""

    # Step 2: Login
    echo -e "${CYAN}Step 2: Login to Wegent${NC}"
    echo ""

    if wegent login; then
        log_success "Login successful!"
    else
        log_error "Login failed. You can try again later with: wegent login"
        show_manual_instructions
        return 1
    fi

    echo ""

    # Step 3: Start executor
    echo -e "${CYAN}Step 3: Start Local Executor${NC}"
    echo ""
    echo -e "Start executor in background (daemon mode)?"
    echo -e "  ${GREEN}[Y]${NC} Yes, run in background (recommended)"
    echo -e "  ${YELLOW}[n]${NC} No, run in foreground"
    read -r -p "Choose [Y/n]: " executor_choice

    echo ""

    case "$executor_choice" in
        n|N)
            log_info "Starting executor in foreground mode..."
            echo ""
            echo -e "${YELLOW}Press Ctrl+C to stop the executor${NC}"
            echo ""
            wegent executor start
            ;;
        *)
            log_info "Starting executor in background mode..."
            if wegent executor start -d; then
                log_success "Executor started successfully!"
                echo ""
                echo -e "View logs with: ${YELLOW}tail -f ~/.wegent/logs/executor.log${NC}"
                echo -e "Stop executor with: ${YELLOW}wegent executor stop${NC}"
            else
                log_error "Failed to start executor"
                return 1
            fi
            ;;
    esac

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Setup Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "${CYAN}Your executor is now ready to receive tasks.${NC}"
    echo ""
    show_common_commands
}

# Show manual setup instructions
show_manual_instructions() {
    echo ""
    echo -e "${CYAN}Quick Start:${NC}"
    echo ""
    echo -e "  1. Configure server:"
    echo -e "     ${YELLOW}wegent config set server http://your-server:8000${NC}"
    echo ""
    echo -e "  2. Login:"
    echo -e "     ${YELLOW}wegent login${NC}"
    echo ""
    echo -e "  3. Start local executor:"
    echo -e "     ${YELLOW}wegent executor start -d${NC}    # Run in background"
    echo ""
    show_common_commands
}

# Show common commands
show_common_commands() {
    echo -e "${CYAN}Useful Commands:${NC}"
    echo -e "  ${YELLOW}wegent --help${NC}                 # Show all commands"
    echo -e "  ${YELLOW}wegent get teams${NC}              # List all teams"
    echo -e "  ${YELLOW}wegent executor stop${NC}          # Stop executor"
    echo -e "  ${YELLOW}wegent executor restart -d${NC}    # Restart executor in background"
    echo -e "  ${YELLOW}wegent executor update${NC}        # Update executor binary"
    echo ""
    echo -e "${CYAN}Documentation:${NC}"
    echo -e "  https://github.com/${REPO_OWNER}/${REPO_NAME}"
    echo ""
}

# Main installation flow
main() {
    check_requirements
    detect_platform
    get_latest_version

    echo ""

    # Install executor binary
    if ! install_executor; then
        log_warn "Continuing without executor binary..."
    fi

    echo ""

    # Install CLI
    if ! install_cli; then
        log_error "Failed to install wegent CLI"
        exit 1
    fi

    echo ""

    # Verify
    verify_installation

    # Show instructions
    show_instructions
}

# Run main
main
