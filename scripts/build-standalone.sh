#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build standalone Docker image for Wegent
# This script builds a single image containing Backend, Frontend, Chat Shell, and Executor

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Default values
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/wecode-ai/wegent-standalone}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-}"
NO_CACHE="${NO_CACHE:-false}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --tag|-t)
            IMAGE_TAG="$2"
            shift 2
            ;;
        --platform|-p)
            PLATFORM="$2"
            shift 2
            ;;
        --no-cache)
            NO_CACHE="true"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Build Wegent Standalone Docker image"
            echo ""
            echo "Options:"
            echo "  -t, --tag TAG       Image tag (default: latest)"
            echo "  -p, --platform      Target platform (e.g., linux/amd64, linux/arm64)"
            echo "  --no-cache          Build without using cache"
            echo "  -h, --help          Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                           # Build with default settings"
            echo "  $0 --tag v1.0.0              # Build with specific tag"
            echo "  $0 --platform linux/amd64    # Build for specific platform"
            echo "  $0 --no-cache                # Build without cache"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

echo "=========================================="
echo "  Building Wegent Standalone Image"
echo "=========================================="
echo ""
echo "  Image: ${IMAGE_NAME}:${IMAGE_TAG}"
if [ -n "$PLATFORM" ]; then
    echo "  Platform: ${PLATFORM}"
fi
echo "  No Cache: ${NO_CACHE}"
echo ""
echo "=========================================="
echo ""

# Build Docker command
BUILD_CMD="docker build"
BUILD_CMD="$BUILD_CMD -f docker/standalone/Dockerfile"
BUILD_CMD="$BUILD_CMD -t ${IMAGE_NAME}:${IMAGE_TAG}"

if [ -n "$PLATFORM" ]; then
    BUILD_CMD="$BUILD_CMD --platform ${PLATFORM}"
fi

if [ "$NO_CACHE" = "true" ]; then
    BUILD_CMD="$BUILD_CMD --no-cache"
fi

BUILD_CMD="$BUILD_CMD ."

# Execute build
echo "Running: $BUILD_CMD"
echo ""
eval $BUILD_CMD

echo ""
echo "=========================================="
echo "  Build Complete!"
echo "=========================================="
echo ""
echo "  Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "  Run with:"
echo ""
echo "    docker run -d --name wegent \\"
echo "      -p 3000:3000 -p 8000:8000 \\"
echo "      -e REDIS_URL=redis://host.docker.internal:6379/0 \\"
echo "      -v wegent-data:/app/data \\"
echo "      ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "  Or use docker-compose:"
echo ""
echo "    docker-compose -f docker-compose.standalone.yml up -d"
echo ""
echo "=========================================="
