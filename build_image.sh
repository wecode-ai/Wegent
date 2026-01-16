#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build docker images for wecode components
# Usage: 
#   ./build_image.sh [OPTIONS]      - Build images with default version 1.0.0
#   ./build_image.sh version=2.0.0  - Build images with specified version
#   ./build_image.sh -h             - Show this help message (short form)

# Default version
DEFAULT_VERSION="1.0.0"

# Function to show help
show_help() {
    echo "Build docker images for Wegent components"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -v, --version VERSION     Specify the version to build (default: $DEFAULT_VERSION)"
    echo "  version=VERSION           Specify the version using key=value format"
    echo "  -p, --push                Build and push images to registry"
    echo "  -h, --help                Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                        Build images with default version"
    echo "  $0 version=2.0.0          Build images with version 2.0.0"
    echo "  $0 --version 2.0.0        Build images with version 2.0.0"
    echo "  $0 -v 2.0.0               Build images with version 2.0.0 (short form)"
    echo "  $0 --push                 Build and push images"
    echo "  $0 -p                     Build and push images (short form)"
    echo "  $0 -v 2.0.0 -p            Build and push images with version 2.0.0"
}

# Initialize variables
VERSION="$DEFAULT_VERSION"
PUSH_FLAG=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--version)
            if [[ -n $2 && $2 != -* ]]; then
                VERSION="$2"
                shift 2
            else
                echo "Error: --version requires a value"
                exit 1
            fi
            ;;
        version=*)
            VERSION="${1#version=}"
            shift
            ;;
        -p|--push)
            PUSH_FLAG="--push"
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Error: Unknown option $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

if [ "$PUSH_FLAG" == "--push" ]; then
    echo "Building and pushing images with version $VERSION..."
else
    echo "Building images with version $VERSION (use --push or -p to also push images)..."
fi

# Build backend image
docker buildx build --network=host ${PUSH_FLAG} --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-backend:${VERSION} -f docker/backend/Dockerfile .

# Build frontend image
docker buildx build --network=host ${PUSH_FLAG} --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-web:${VERSION} -f docker/frontend/Dockerfile .

# Build executor image
docker buildx build --network=host ${PUSH_FLAG} --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-executor:${VERSION} -f docker/executor/Dockerfile .

# Build executor manager image
docker buildx build --network=host ${PUSH_FLAG} --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-executor-manager:${VERSION} -f docker/executor_manager/Dockerfile .

# Build chat shell image
docker buildx build --network=host ${PUSH_FLAG} --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-chat-shell:${VERSION} -f docker/chat_shell/Dockerfile .