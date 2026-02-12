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
from textwrap import dedent

logger = logging.getLogger(__name__)

# Cloud-init script template
# Uses MIME multipart format for cloud-init compatibility
CLOUD_INIT_SCRIPT_TEMPLATE = """\
Content-Type: multipart/mixed; boundary="==BOUNDARY=="
MIME-Version: 1.0

--==BOUNDARY==
Content-Type: text/x-shellscript; charset="utf-8"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="startup.sh"

#!/bin/bash
# Cloud device startup script
# device_id: {device_id}
# user_name: {user_name}

# Log to home directory
LOG_DIR="$HOME/.wegent-executor"
mkdir -p "$LOG_DIR"
exec > "$LOG_DIR/cloud-init.log" 2>&1
set -x

echo "[CloudDevice] Starting cloud device setup at $(date)"
echo "[CloudDevice] Running as user: $(whoami)"
echo "[CloudDevice] HOME=$HOME"

# Wait for network
sleep 5

# Check if executor exists
EXECUTOR_PATH="$HOME/.wegent-executor/bin/wegent-executor"
if [ ! -f "$EXECUTOR_PATH" ]; then
    echo "[CloudDevice] Executor not found at $EXECUTOR_PATH"
    EXECUTOR_PATH="/usr/local/bin/wegent-executor"
    if [ ! -f "$EXECUTOR_PATH" ]; then
        echo "[CloudDevice] ERROR: Executor not found!"
        exit 1
    fi
fi

echo "[CloudDevice] Starting executor from $EXECUTOR_PATH"

# Export environment variables
export EXECUTOR_MODE=local
export WEGENT_BACKEND_URL="{backend_url}"
export WEGENT_AUTH_TOKEN="{auth_token}"
export ANTHROPIC_CUSTOM_HEADERS=$'wecode-source: wegent-cloud\\nwecode-action: wegent\\nwecode-executor: claudecode'

# Start executor
nohup "$EXECUTOR_PATH" > "$LOG_DIR/executor.log" 2>&1 &

echo "[CloudDevice] Executor started with PID $!"
echo "[CloudDevice] Setup complete at $(date)"

--==BOUNDARY==--
"""


def generate_cloud_init_script(
    device_id: str,
    user_name: str,
    backend_url: str,
    auth_token: str,
) -> str:
    """Generate Base64 encoded cloud-init startup script.

    The script performs the following tasks:
    1. Sets up logging to ~/.wegent-executor/cloud-init.log
    2. Waits for network connectivity
    3. Locates the pre-installed wegent-executor binary
    4. Configures environment variables for backend connection
    5. Starts the executor as a background process

    Args:
        device_id: Cloud device identifier (sandbox ID)
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token

    Returns:
        Base64 encoded script string for cloud-init user_data
    """
    script = CLOUD_INIT_SCRIPT_TEMPLATE.format(
        device_id=device_id,
        user_name=user_name,
        backend_url=backend_url,
        auth_token=auth_token,
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
) -> str:
    """Generate Base64 encoded simple startup script (non-MIME format).

    This is an alternative script format without MIME multipart wrapper,
    for environments that don't require cloud-init MIME format.

    Args:
        device_id: Cloud device identifier (sandbox ID)
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token

    Returns:
        Base64 encoded script string
    """
    script = dedent(f"""\
        #!/bin/bash
        # Cloud device startup script
        # device_id: {device_id}
        # user_name: {user_name}

        # Log to home directory
        LOG_DIR="$HOME/.wegent-executor"
        mkdir -p "$LOG_DIR"
        exec > "$LOG_DIR/cloud-init.log" 2>&1
        set -x

        echo "[CloudDevice] Starting cloud device setup at $(date)"
        echo "[CloudDevice] Running as user: $(whoami)"
        echo "[CloudDevice] HOME=$HOME"

        # Wait for network
        sleep 5

        # Check if executor exists
        EXECUTOR_PATH="$HOME/.wegent-executor/bin/wegent-executor"
        if [ ! -f "$EXECUTOR_PATH" ]; then
            echo "[CloudDevice] Executor not found at $EXECUTOR_PATH"
            EXECUTOR_PATH="/usr/local/bin/wegent-executor"
            if [ ! -f "$EXECUTOR_PATH" ]; then
                echo "[CloudDevice] ERROR: Executor not found!"
                exit 1
            fi
        fi

        echo "[CloudDevice] Starting executor from $EXECUTOR_PATH"

        # Export environment variables
        export EXECUTOR_MODE=local
        export WEGENT_BACKEND_URL="{backend_url}"
        export WEGENT_AUTH_TOKEN="{auth_token}"
        export ANTHROPIC_CUSTOM_HEADERS=$'wecode-source: wegent-cloud\\nwecode-action: wegent\\nwecode-executor: claudecode'

        # Start executor
        nohup "$EXECUTOR_PATH" > "$LOG_DIR/executor.log" 2>&1 &

        echo "[CloudDevice] Executor started with PID $!"
        echo "[CloudDevice] Setup complete at $(date)"
    """)

    # Encode to Base64
    encoded = base64.b64encode(script.encode("utf-8")).decode("utf-8")

    logger.debug(
        f"Generated simple startup script for device_id={device_id}, "
        f"user_name={user_name}, script_length={len(script)}"
    )

    return encoded
