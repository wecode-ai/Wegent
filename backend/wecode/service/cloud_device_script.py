# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device startup script generator.

Generates cloud-init compatible startup scripts for cloud devices.
The script configures and starts wegent-executor on VM boot.
"""

import base64
import logging

logger = logging.getLogger(__name__)


def generate_cloud_init_script(
    device_id: str,
    user_name: str,
    backend_url: str,
    auth_token: str,
    executor_download_url: str = "",
    executor_download_token: str = "",
) -> str:
    """Generate Base64 encoded cloud-init startup script.

    The script performs the following tasks:
    1. Creates log directory /home/ubuntu/.wegent-executor/logs
    2. Waits for network connectivity
    3. Downloads wegent-executor binary if not pre-installed
    4. Configures environment variables for backend connection
    5. Starts the executor as ubuntu user

    Args:
        device_id: Cloud device identifier (sandbox ID)
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token
        executor_download_url: URL for downloading executor binary.
        executor_download_token: Private token for authenticated download.

    Returns:
        Base64 encoded script string for cloud-init user_data
    """
    script = _generate_user_data_script(
        device_id,
        user_name,
        backend_url,
        auth_token,
        executor_download_url,
        executor_download_token,
    )

    # Encode to Base64
    encoded = base64.b64encode(script.encode("utf-8")).decode("utf-8")

    logger.debug(
        f"Generated cloud-init script for device_id={device_id}, "
        f"user_name={user_name}, script_length={len(script)}"
    )

    return encoded


def generate_simple_startup_script(
    device_id: str,
    user_name: str,
    backend_url: str,
    auth_token: str,
    executor_download_url: str = "",
    executor_download_token: str = "",
) -> str:
    """Generate Base64 encoded simple startup script (non-MIME format).

    This is an alternative script format without MIME multipart wrapper,
    for environments that don't require cloud-init MIME format.

    The script runs as root initially, then switches to ubuntu user to
    execute the wegent-executor.

    Args:
        device_id: Cloud device identifier (sandbox ID)
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token
        executor_download_url: URL for downloading executor binary.
        executor_download_token: Private token for authenticated download.

    Returns:
        Base64 encoded script string
    """
    script = _generate_user_data_script(
        device_id,
        user_name,
        backend_url,
        auth_token,
        executor_download_url,
        executor_download_token,
    )

    # Encode to Base64
    encoded = base64.b64encode(script.encode("utf-8")).decode("utf-8")

    logger.debug(
        f"Generated simple startup script for device_id={device_id}, "
        f"user_name={user_name}, script_length={len(script)}"
    )

    return encoded


def _generate_user_data_script(
    device_id: str,
    user_name: str,
    backend_url: str,
    auth_token: str,
    executor_download_url: str = "",
    executor_download_token: str = "",
) -> str:
    """
    Generate startup script (user_data) for cloud device.

    This script runs when the VM starts and launches the executor.
    Uses sudo -i -u ubuntu to switch to ubuntu user.
    """
    # Build the full curl download command in Python to avoid
    # shell quoting issues with PRIVATE-TOKEN header in heredoc.
    # Use URL decoded path for GitLab API
    download_url = executor_download_url.replace("%2F", "/")
    curl_parts = ["curl", "-fsSL", "--retry", "3", "--retry-delay", "5"]
    if executor_download_token:
        curl_parts.append(f"-H 'PRIVATE-TOKEN: {executor_download_token}'")
    curl_parts.extend(["-o", '"$EXECUTOR_PATH.tmp"', f'"{download_url}"'])
    curl_download_cmd = " ".join(curl_parts)

    return f"""#!/bin/bash
# ===============================
# Wegent Executor Install & Run (Cloud Device)
# device_id: {device_id}
# user_name: {user_name}
# ===============================

# Log to file first (as root)
LOG_DIR="/home/ubuntu/.wegent-executor/logs"
mkdir -p "$LOG_DIR"
chown -R ubuntu:ubuntu "/home/ubuntu/.wegent-executor"
exec > "$LOG_DIR/cloud-init.log" 2>&1
set -x

echo "[CloudDevice] Starting cloud device setup at $(date)"

# Wait for network
sleep 5

# Run as ubuntu user
sudo -i -u ubuntu bash << 'UBUNTU_SCRIPT'
set -e
set -x

AUTH_TOKEN="{auth_token}"

BASE_DIR="$HOME/.wegent-executor"
BIN_DIR="$BASE_DIR/bin"
LOG_DIR="$BASE_DIR/logs"
PID_FILE="$BASE_DIR/.wegent-executor.pid"
AUTH_FILE="$BASE_DIR/.auth-token"

CALLBACK_URL="{backend_url}"

# ===============================
# Step 1: Create directories
# ===============================
echo "Creating directories..."
mkdir -p "$BIN_DIR"
mkdir -p "$LOG_DIR"

# ===============================
# Step 2: Stop wegent-executor if running (before download)
# ===============================
echo "Checking for running wegent-executor..."
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "   wegent-executor is running (PID: $OLD_PID), stopping..."
        kill -TERM "$OLD_PID" 2>/dev/null || true
        sleep 1
        if kill -0 "$OLD_PID" 2>/dev/null; then
            kill -9 "$OLD_PID" 2>/dev/null || true
        fi
        echo "   Stopped"
    fi
    rm -f "$PID_FILE"
fi

# ===============================
# Step 3: Save auth token
# ===============================
echo "Saving auth token..."
echo "$AUTH_TOKEN" > "$AUTH_FILE"
chmod 600 "$AUTH_FILE"

# ===============================
# Step 4: Download wegent-executor
# ===============================
EXECUTOR_PATH="$BIN_DIR/wegent-executor"

# Always download latest executor to ensure version alignment
echo "Downloading wegent-executor..."
echo "   URL: {executor_download_url}"
echo "   Target: $EXECUTOR_PATH.tmp"
echo "   Bin dir exists: $(ls -ld "$BIN_DIR" 2>/dev/null && echo 'yes' || echo 'no')"

# Download with verbose error output
if {curl_download_cmd}; then
    mv "$EXECUTOR_PATH.tmp" "$EXECUTOR_PATH"
    chmod +x "$EXECUTOR_PATH"
    echo "   Downloaded successfully"
    echo "   File size: $(ls -lh "$EXECUTOR_PATH" | awk '{{print $5}}')"
else
    echo "   Download failed with exit code: $?"
    echo "   Curl command was: curl -fsSL --retry 3 --retry-delay 5 -H 'PRIVATE-TOKEN: ***' -o \"$EXECUTOR_PATH.tmp\" \"{executor_download_url}\""
    rm -f "$EXECUTOR_PATH.tmp"
fi

# Fallback to pre-installed binary if download failed
if [ ! -f "$EXECUTOR_PATH" ]; then
    if [ -f "/usr/local/bin/wegent-executor" ]; then
        echo "   Using pre-installed /usr/local/bin/wegent-executor"
        cp /usr/local/bin/wegent-executor "$EXECUTOR_PATH"
        chmod +x "$EXECUTOR_PATH"
    else
        echo "Error: wegent-executor not found and download failed!"
        exit 1
    fi
fi

# ===============================
# Step 5: Configure PATH
# ===============================
echo ""
echo "Configuring PATH..."

# Detect shell config file
SHELL_NAME=$(basename "$SHELL")
if [ "$SHELL_NAME" = "zsh" ]; then
    SHELL_CONFIG="$HOME/.zshrc"
else
    SHELL_CONFIG="$HOME/.bashrc"
fi

if ! grep -q ".wegent-executor/bin" "$SHELL_CONFIG" 2>/dev/null; then
    echo '' >> "$SHELL_CONFIG"
    echo 'export PATH="$HOME/.wegent-executor/bin:$PATH"' >> "$SHELL_CONFIG"
    echo "   Added to $SHELL_CONFIG (effective in new terminal)"
else
    echo "   PATH already configured in $SHELL_CONFIG"
fi

# Add to current session
export PATH="$BIN_DIR:$PATH"

# ===============================
# Step 6: Start wegent-executor
# ===============================
echo ""
echo "Starting wegent-executor..."

LOG_FILE="$LOG_DIR/wegent-executor.log"
ERROR_LOG_FILE="$LOG_DIR/wegent-executor-error.log"

# Set environment variables
export EXECUTOR_MODE="local"
export WEGENT_BACKEND_URL="$CALLBACK_URL"
export WEGENT_AUTH_TOKEN="$AUTH_TOKEN"
export ANTHROPIC_CUSTOM_HEADERS="wecode-source: wegent-local
wecode-action: wegent
wecode-executor: claudecode"

# Start in background
nohup "$EXECUTOR_PATH" > "$LOG_FILE" 2> "$ERROR_LOG_FILE" &
NEW_PID=$!

# Save PID
echo "$NEW_PID" > "$PID_FILE"

# Wait a moment and check if process started successfully
sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "wegent-executor started successfully!"
    echo "   PID: $NEW_PID"
    echo "   Log: $LOG_FILE"
else
    echo "wegent-executor failed to start!"
    if [ -f "$ERROR_LOG_FILE" ]; then
        echo "   Error log:"
        cat "$ERROR_LOG_FILE"
    fi
    rm -f "$PID_FILE"
    exit 1
fi

echo ""
echo "Done!"
UBUNTU_SCRIPT

echo "[CloudDevice] Setup complete at $(date)"
"""
