#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Wegent Executor Installation Script
# This script downloads and installs the wegent-executor binary for macOS.
#
# Usage:
#   curl -fsSL https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh | bash
#
# Or with a specific version:
#   curl -fsSL https://github.com/wecode-ai/Wegent/releases/download/v1.0.0/local_executor_install.sh | bash -s -- --version v1.0.0

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GITHUB_REPO="wecode-ai/Wegent"
INSTALL_DIR="${HOME}/.wegent-executor/bin"
BINARY_NAME="wegent-executor"
VERSION=""

# Claude Code minimum version requirement
# Based on Docker image version: @anthropic-ai/claude-code@2.1.27
MIN_CLAUDE_CODE_VERSION="2.1.0"
MIN_NODE_VERSION="18"

# Print colored message
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Compare semantic versions
# Returns 0 if version1 >= version2, 1 otherwise
version_compare() {
    local version1="$1"
    local version2="$2"

    # Remove 'v' prefix if present
    version1="${version1#v}"
    version2="${version2#v}"

    # Split versions into arrays
    IFS='.' read -ra v1_parts <<< "$version1"
    IFS='.' read -ra v2_parts <<< "$version2"

    # Compare each part
    for i in 0 1 2; do
        local v1_part="${v1_parts[$i]:-0}"
        local v2_part="${v2_parts[$i]:-0}"

        # Extract numeric part only (handles versions like "2.1.27-beta")
        v1_part="${v1_part%%[^0-9]*}"
        v2_part="${v2_part%%[^0-9]*}"

        if (( v1_part > v2_part )); then
            return 0
        elif (( v1_part < v2_part )); then
            return 1
        fi
    done

    return 0  # Versions are equal
}

# Check if Node.js is installed
check_nodejs() {
    print_info "Checking Node.js installation..."

    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed."
        print_error "Claude Code requires Node.js ${MIN_NODE_VERSION}+ to run."
        echo ""
        print_info "Please install Node.js first:"
        echo "  - Visit: https://nodejs.org/"
        echo "  - Or use Homebrew: brew install node"
        echo "  - Or use nvm: nvm install ${MIN_NODE_VERSION}"
        echo ""
        exit 1
    fi

    local node_version
    node_version="$(node --version 2>/dev/null)"
    # Remove 'v' prefix
    local node_version_num="${node_version#v}"
    local node_major="${node_version_num%%.*}"

    if (( node_major < MIN_NODE_VERSION )); then
        print_error "Node.js version ${node_version} is too old."
        print_error "Claude Code requires Node.js ${MIN_NODE_VERSION}+ to run."
        echo ""
        print_info "Please upgrade Node.js:"
        echo "  - Visit: https://nodejs.org/"
        echo "  - Or use Homebrew: brew upgrade node"
        echo "  - Or use nvm: nvm install ${MIN_NODE_VERSION}"
        echo ""
        exit 1
    fi

    print_success "Node.js found: ${node_version}"
}

# Check if npm is available
check_npm() {
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed."
        print_error "npm is required to install Claude Code."
        echo ""
        print_info "npm usually comes with Node.js. Please reinstall Node.js."
        echo ""
        exit 1
    fi
}

# Install or upgrade Claude Code
install_claude_code() {
    print_info "Checking Claude Code installation..."

    local claude_installed=false
    local current_version=""

    # Check if Claude Code is installed
    if command -v claude &> /dev/null; then
        claude_installed=true
        # Get current version - claude --version outputs something like "claude 2.1.27"
        current_version="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || true
    fi

    if [[ "$claude_installed" == "false" ]]; then
        print_info "Claude Code not found, installing via npm..."
        check_npm

        if ! npm install -g @anthropic-ai/claude-code; then
            print_error "Failed to install Claude Code via npm."
            echo ""
            print_info "You can try installing manually:"
            echo "  npm install -g @anthropic-ai/claude-code"
            echo ""
            print_info "If you encounter permission issues, try:"
            echo "  sudo npm install -g @anthropic-ai/claude-code"
            echo ""
            exit 1
        fi

        # Verify installation
        if ! command -v claude &> /dev/null; then
            print_error "Claude Code installation failed - 'claude' command not found."
            exit 1
        fi

        current_version="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || true
        print_success "Claude Code installed: v${current_version}"

    elif [[ -n "$current_version" ]]; then
        # Check version compatibility
        if ! version_compare "$current_version" "$MIN_CLAUDE_CODE_VERSION"; then
            print_warning "Claude Code version ${current_version} is below minimum required version ${MIN_CLAUDE_CODE_VERSION}"
            print_info "Upgrading Claude Code..."
            check_npm

            if ! npm update -g @anthropic-ai/claude-code; then
                print_warning "Failed to upgrade Claude Code via npm."
                print_info "You can try upgrading manually:"
                echo "  npm update -g @anthropic-ai/claude-code"
                echo ""
                # Don't exit, continue with existing version
            else
                current_version="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || true
                print_success "Claude Code upgraded to: v${current_version}"
            fi
        else
            print_success "Claude Code found: v${current_version}"
        fi
    else
        print_success "Claude Code found (version unknown)"
    fi
}

# Detect OS and architecture
detect_platform() {
    local os
    local arch

    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Darwin)
            OS="macos"
            ;;
        Linux)
            print_error "Linux is not yet supported. Please use Docker deployment."
            exit 1
            ;;
        *)
            print_error "Unsupported operating system: $os"
            exit 1
            ;;
    esac

    case "$arch" in
        x86_64)
            ARCH="amd64"
            ;;
        arm64|aarch64)
            ARCH="arm64"
            ;;
        *)
            print_error "Unsupported architecture: $arch"
            exit 1
            ;;
    esac

    PLATFORM="${OS}-${ARCH}"
    print_info "Detected platform: ${PLATFORM}"
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --version|-v)
                VERSION="$2"
                shift 2
                ;;
            --help|-h)
                echo "Wegent Executor Installation Script"
                echo ""
                echo "Usage:"
                echo "  curl -fsSL <url>/install.sh | bash"
                echo "  curl -fsSL <url>/install.sh | bash -s -- --version v1.0.0"
                echo ""
                echo "Options:"
                echo "  --version, -v    Specify version to install (e.g., v1.0.0)"
                echo "  --help, -h       Show this help message"
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

# Get download URL
get_download_url() {
    local base_url="https://github.com/${GITHUB_REPO}/releases"

    if [[ -n "$VERSION" ]]; then
        DOWNLOAD_URL="${base_url}/download/${VERSION}/${BINARY_NAME}-${PLATFORM}"
    else
        DOWNLOAD_URL="${base_url}/latest/download/${BINARY_NAME}-${PLATFORM}"
    fi

    print_info "Download URL: ${DOWNLOAD_URL}"
}

# Create installation directory
create_install_dir() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        print_info "Creating installation directory: ${INSTALL_DIR}"
        mkdir -p "$INSTALL_DIR"
    fi
}

# Download binary
download_binary() {
    local tmp_file
    tmp_file="$(mktemp)"

    print_info "Downloading ${BINARY_NAME}..."

    if command -v curl &> /dev/null; then
        if ! curl -fsSL -o "$tmp_file" "$DOWNLOAD_URL"; then
            print_error "Failed to download ${BINARY_NAME}"
            rm -f "$tmp_file"
            exit 1
        fi
    elif command -v wget &> /dev/null; then
        if ! wget -q -O "$tmp_file" "$DOWNLOAD_URL"; then
            print_error "Failed to download ${BINARY_NAME}"
            rm -f "$tmp_file"
            exit 1
        fi
    else
        print_error "Neither curl nor wget found. Please install one of them."
        exit 1
    fi

    # Move to installation directory
    mv "$tmp_file" "${INSTALL_DIR}/${BINARY_NAME}"

    # Set executable permission
    chmod 755 "${INSTALL_DIR}/${BINARY_NAME}"

    print_success "Downloaded ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"
}

# Verify installation
verify_installation() {
    if [[ -x "${INSTALL_DIR}/${BINARY_NAME}" ]]; then
        print_success "Installation verified successfully"
    else
        print_error "Installation verification failed"
        exit 1
    fi
}

# Print usage instructions
print_usage_instructions() {
    echo ""
    echo "======================================"
    echo -e "${GREEN}Installation Complete!${NC}"
    echo "======================================"
    echo ""
    echo "To run wegent-executor, use the following command:"
    echo ""
    echo -e "${YELLOW}EXECUTOR_MODE=local \\\\${NC}"
    echo -e "${YELLOW}WEGENT_BACKEND_URL=<your-backend-url> \\\\${NC}"
    echo -e "${YELLOW}WEGENT_AUTH_TOKEN=<your-auth-token> \\\\${NC}"
    echo -e "${YELLOW}${INSTALL_DIR}/${BINARY_NAME}${NC}"
    echo ""
    echo "Or add the binary to your PATH:"
    echo ""
    echo -e "${BLUE}export PATH=\"\$PATH:${INSTALL_DIR}\"${NC}"
    echo ""
    echo "Add this line to your ~/.zshrc or ~/.bashrc to make it permanent."
    echo ""
    print_warning "First run may require allowing the binary in:"
    print_warning "System Settings > Privacy & Security"
    echo ""
}

# Main function
main() {
    echo ""
    echo "======================================"
    echo "  Wegent Executor Installation Script"
    echo "======================================"
    echo ""

    parse_args "$@"
    detect_platform
    check_nodejs
    install_claude_code
    get_download_url
    create_install_dir
    download_binary
    verify_installation
    print_usage_instructions
}

main "$@"
