#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Wegent Executor Installation Script
# This script downloads and installs the wegent-executor binary for macOS.
#
# Usage:
#   curl -fsSL https://github.com/wecode-ai/Wegent/releases/latest/download/install.sh | bash
#
# Or with a specific version:
#   curl -fsSL https://github.com/wecode-ai/Wegent/releases/download/v1.0.0/install.sh | bash -s -- --version v1.0.0

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
    get_download_url
    create_install_dir
    download_binary
    verify_installation
    print_usage_instructions
}

main "$@"
