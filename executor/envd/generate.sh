#!/bin/bash

# Script to generate protobuf files from .proto definitions

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_DIR="$SCRIPT_DIR"
GEN_DIR="$SCRIPT_DIR/gen"

echo "Generating protobuf files..."

# Install required packages if not already installed
pip install -q grpcio-tools protobuf

# Generate Process service
echo "Generating Process service..."
python -m grpc_tools.protoc \
    --proto_path="$PROTO_DIR" \
    --python_out="$GEN_DIR/process" \
    --pyi_out="$GEN_DIR/process" \
    --grpc_python_out="$GEN_DIR/process" \
    "$PROTO_DIR/process/process.proto"

# Generate Filesystem service
echo "Generating Filesystem service..."
python -m grpc_tools.protoc \
    --proto_path="$PROTO_DIR" \
    --python_out="$GEN_DIR/filesystem" \
    --pyi_out="$GEN_DIR/filesystem" \
    --grpc_python_out="$GEN_DIR/filesystem" \
    "$PROTO_DIR/filesystem/filesystem.proto"

echo "Protobuf generation complete!"
echo ""
echo "Generated files:"
echo "  - $GEN_DIR/process/process_pb2.py"
echo "  - $GEN_DIR/process/process_pb2.pyi"
echo "  - $GEN_DIR/process/process_pb2_grpc.py"
echo "  - $GEN_DIR/filesystem/filesystem_pb2.py"
echo "  - $GEN_DIR/filesystem/filesystem_pb2.pyi"
echo "  - $GEN_DIR/filesystem/filesystem_pb2_grpc.py"

