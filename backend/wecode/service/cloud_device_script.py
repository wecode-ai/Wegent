# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device startup script generator.

Generates cloud-init compatible startup scripts for cloud devices.
The script downloads and executes the shared install script
(device_install-and-run-wegent.sh) which handles binary download,
configuration, and executor startup.
"""

import base64
import json
import logging
import shlex
from typing import Any, Dict, List, Optional

from app.services.device.git_credentials_command import (
    GIT_CREDENTIALS_SECRET_ENV,
    SYNC_GIT_CREDENTIALS_COMMAND,
)
from wecode.service.cloud_device_git_tokens import build_git_token_envs

logger = logging.getLogger(__name__)

CLOUD_EXECUTOR_HOME = "/home/ubuntu/.wegent-executor"
CLOUD_WORKSPACE_ROOT = f"{CLOUD_EXECUTOR_HOME}/workspace"


def build_cloud_device_runtime_envs(device_id: str) -> Dict[str, str]:
    """Build the stable runtime environment for a managed cloud device."""
    if not device_id:
        return {}
    return {
        "DEVICE_TYPE": "cloud",
        "WEGENT_EXECUTOR_HOME": CLOUD_EXECUTOR_HOME,
        "LOCAL_WORKSPACE_ROOT": CLOUD_WORKSPACE_ROOT,
        "WEGENT_EXECUTOR_HOME_ID": device_id,
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED": "true",
    }


def generate_cloud_init_script(
    user_name: str,
    backend_url: str,
    auth_token: str,
    user_jwt_token: str = "",
    install_script_url: str = "",
    install_script_token: str = "",
    mail_email: str = "",
    mail_password: str = "",
    git_tokens: Optional[List[Dict[str, Any]]] = None,
    device_id: str = "",
    device_name: str = "",
    ubuntu_password: str = "",
    openclaw_script_url: str = "",
    api_key: str = "",
    openclaw_device_id: str = "",
) -> str:
    """Generate Base64 encoded cloud-init startup script.

    The script downloads and executes the shared install script which:
    1. Downloads the wegent-executor binary
    2. Configures environment variables for backend connection
    3. Starts the executor as ubuntu user

    Args:
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token
        user_jwt_token: Current user's JWT token for user-scoped integrations.
        install_script_url: URL of the install script to download and execute.
        install_script_token: Private token for authenticated download.
        mail_email: Optional mail account username for himalaya mail skill.
        mail_password: Optional mail account password for himalaya mail skill.
        git_tokens: User git tokens passed through to the cloud device.
        device_id: Server-generated device UUID.
        device_name: Server-generated device name.
        ubuntu_password: Login password for the ubuntu system user.
        openclaw_script_url: URL of the OpenClaw install script to download.
        api_key: API key for OpenClaw script authentication.
        openclaw_device_id: Server-generated device UUID for OpenClaw.

    Returns:
        Base64 encoded script string for cloud-init user_data
    """
    script = _generate_user_data_script(
        user_name,
        backend_url,
        auth_token,
        user_jwt_token,
        install_script_url,
        install_script_token,
        mail_email,
        mail_password,
        git_tokens,
        device_id,
        device_name,
        ubuntu_password,
        openclaw_script_url,
        api_key,
        openclaw_device_id,
    )

    encoded = base64.b64encode(script.encode("utf-8")).decode("utf-8")

    logger.debug(
        f"Generated cloud-init script for user_name={user_name}, "
        f"script_length={len(script)}"
    )

    return encoded


def generate_simple_startup_script(
    user_name: str,
    backend_url: str,
    auth_token: str,
    user_jwt_token: str = "",
    install_script_url: str = "",
    install_script_token: str = "",
    mail_email: str = "",
    mail_password: str = "",
    git_tokens: Optional[List[Dict[str, Any]]] = None,
    device_id: str = "",
    device_name: str = "",
    ubuntu_password: str = "",
    openclaw_script_url: str = "",
    api_key: str = "",
    openclaw_device_id: str = "",
) -> str:
    """Generate Base64 encoded simple startup script (non-MIME format).

    This is an alternative script format without MIME multipart wrapper,
    for environments that don't require cloud-init MIME format.

    Args:
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token
        user_jwt_token: Current user's JWT token for user-scoped integrations.
        install_script_url: URL of the install script to download and execute.
        install_script_token: Private token for authenticated download.
        mail_email: Optional mail account username for himalaya mail skill.
        mail_password: Optional mail account password for himalaya mail skill.
        git_tokens: User git tokens passed through to the cloud device.
        device_id: Server-generated device UUID.
        device_name: Server-generated device name.
        ubuntu_password: Login password for the ubuntu system user.
        openclaw_script_url: URL of the OpenClaw install script to download.
        api_key: API key for OpenClaw script authentication.
        openclaw_device_id: Server-generated device UUID for OpenClaw.

    Returns:
        Base64 encoded script string
    """
    script = _generate_user_data_script(
        user_name,
        backend_url,
        auth_token,
        user_jwt_token,
        install_script_url,
        install_script_token,
        mail_email,
        mail_password,
        git_tokens,
        device_id,
        device_name,
        ubuntu_password,
        openclaw_script_url,
        api_key,
        openclaw_device_id,
    )

    encoded = base64.b64encode(script.encode("utf-8")).decode("utf-8")

    logger.info(
        f"Generated simple startup script for user_name={user_name}, "
        f"script_length={len(script)}"
    )

    return encoded


def _generate_user_data_script(
    user_name: str,
    backend_url: str,
    auth_token: str,
    user_jwt_token: str = "",
    install_script_url: str = "",
    install_script_token: str = "",
    mail_email: str = "",
    mail_password: str = "",
    git_tokens: Optional[List[Dict[str, Any]]] = None,
    device_id: str = "",
    device_name: str = "",
    ubuntu_password: str = "",
    openclaw_script_url: str = "",
    api_key: str = "",
    openclaw_device_id: str = "",
) -> str:
    """Generate startup script (user_data) for cloud device.

    This script runs when the VM starts. It downloads and executes the
    shared install script (device_install-and-run-wegent.sh) as ubuntu user,
    passing the auth token and backend URL via environment variable.

    Args:
        user_name: User name for logging purposes
        backend_url: Backend WebSocket URL for executor connection
        auth_token: User's authentication token
        user_jwt_token: Current user's JWT token for user-scoped integrations.
        install_script_url: URL of the install script to download and execute.
        install_script_token: Private token for authenticated download.
        mail_email: Optional mail account username for himalaya mail skill.
        mail_password: Optional mail account password for himalaya mail skill.
        git_tokens: User git tokens passed through to the cloud device.
        device_id: Server-generated device UUID.
        device_name: Server-generated device name.
        ubuntu_password: Login password for the ubuntu system user.
        openclaw_script_url: URL of the OpenClaw install script to download.
        api_key: API key for OpenClaw script authentication.
        openclaw_device_id: Server-generated device UUID for OpenClaw.
    """
    # Build curl command for downloading the install script
    curl_parts = ["curl", "-fsSL", "--retry", "3", "--retry-delay", "5"]
    if install_script_token:
        curl_parts.append(f"-H 'PRIVATE-TOKEN: {install_script_token}'")
    curl_parts.append(f'"{install_script_url}"')
    curl_download_cmd = " ".join(curl_parts)

    # Build install script arguments
    install_args = f'-t "{auth_token}"'
    if mail_email and mail_password:
        install_args += (
            f" -m -e {shlex.quote(mail_email)} -p {shlex.quote(mail_password)}"
        )

    git_token_exports = _generate_git_token_exports(git_tokens)
    git_clone_config = _generate_git_clone_config(git_tokens)
    ubuntu_password_section = _generate_ubuntu_password_section(ubuntu_password)
    runtime_env_exports = "\n".join(
        f'export {key}="{_escape_double_quoted_env_value(value)}"'
        for key, value in build_cloud_device_runtime_envs(device_id).items()
    )

    # Build openclaw curl command and install arguments
    openclaw_section = ""
    if openclaw_script_url and api_key:
        openclaw_curl_parts = [
            "curl",
            "-fsSL",
            "--retry",
            "3",
            "--retry-delay",
            "5",
        ]
        if install_script_token:
            openclaw_curl_parts.append(f"-H 'PRIVATE-TOKEN: {install_script_token}'")
        openclaw_curl_parts.extend(
            ["-o", "device_install-and-run-openclaw.sh", f'"{openclaw_script_url}"']
        )
        openclaw_curl_cmd = " ".join(openclaw_curl_parts)

        openclaw_install_args = f'-t "{auth_token}" -k "{api_key}"'
        if openclaw_device_id:
            openclaw_install_args += f' -d "{openclaw_device_id}"'

        openclaw_section = f"""
# Download and execute the OpenClaw install script
echo "[CloudDevice] Downloading OpenClaw install script..."
{openclaw_curl_cmd}
chmod +x device_install-and-run-openclaw.sh
echo "[CloudDevice] Running OpenClaw install script..."
./device_install-and-run-openclaw.sh {openclaw_install_args}
echo "[CloudDevice] OpenClaw install script completed"
"""

    return f"""#!/bin/bash
# ===============================
# Wegent Cloud Device Bootstrap
# user_name: {user_name}
# ===============================

# Log to file first (as root)
LOG_DIR="/home/ubuntu/.wegent-executor/logs"
mkdir -p "$LOG_DIR"
chown -R ubuntu:ubuntu "/home/ubuntu/.wegent-executor"
exec > "$LOG_DIR/cloud-init.log" 2>&1
set -x

echo "[CloudDevice] Starting cloud device setup at $(date)"
{ubuntu_password_section}
echo "[CloudDevice] Configuring daily fstrim timer..."
mkdir -p /etc/systemd/system/fstrim.timer.d
cat > /etc/systemd/system/fstrim.timer.d/override.conf << 'EOF'
[Timer]
OnCalendar=daily
EOF
systemctl daemon-reload
systemctl restart fstrim.timer
systemctl enable fstrim.timer
echo "[CloudDevice] Daily fstrim timer configured"

# Install Sinawatch monitoring agent
echo "[CloudDevice] Installing Sinawatch monitoring agent..."
echo "asset_number=$(hostname)" | tee /etc/sinainstall.conf
/usr/bin/wget http://repos.sina.cn/custom-repos/sinawatch/ubuntu/sina-watchagent_latest_amd64.deb -O /tmp/sina-watchagent.deb
/usr/bin/dpkg -i /tmp/sina-watchagent.deb
rm -f /tmp/sina-watchagent.deb
echo "[CloudDevice] Sinawatch installation completed"

# Wait for network
sleep 5

# Run install script as ubuntu user
sudo -i -u ubuntu bash << 'UBUNTU_SCRIPT'
set -e
set -x

# Pre-set backend URL so the install script uses it instead of default
export WEGENT_BACKEND_URL="{backend_url}"

# Export current user identity for scripts running on the cloud device
export WEGENT_USER_JWT_TOKEN="{user_jwt_token}"
export WEGENT_USER_NAME="{user_name}"
{git_token_exports}
{git_clone_config}

# Export server-generated device ID and name
export DEVICE_ID="{device_id}"
export DEVICE_NAME="{device_name}"
{runtime_env_exports}

# Download and execute the shared install script
{curl_download_cmd} | bash -s -- {install_args}

# Wait for executor setup to complete
sleep 3
{openclaw_section}
# Open Chrome browser with weibo.com as ubuntu user
echo "[CloudDevice] Opening Chrome browser with weibo.com..."

# Set DISPLAY for GUI applications
export DISPLAY=:0

# Wait for X server to be ready
for i in {{1..30}}; do
    if xdpyinfo &>/dev/null; then
        echo "[CloudDevice] X server is ready"
        break
    fi
    echo "[CloudDevice] Waiting for X server... ($i/30)"
    sleep 1
done

# Launch Chrome in the background with weibo.com
# Use nohup to prevent termination when script exits
nohup google-chrome --no-first-run --no-default-browser-check --start-maximized https://weibo.com </dev/null >/dev/null 2>&1 &

echo "[CloudDevice] Chrome browser launched with weibo.com"

UBUNTU_SCRIPT

echo "[CloudDevice] Setup complete at $(date)"
"""


def _generate_ubuntu_password_section(ubuntu_password: str) -> str:
    """Generate root commands to set the ubuntu user's password."""
    if not ubuntu_password:
        return ""

    return f"""
# Set the ubuntu user's login password without leaking it to xtrace logs
echo "[CloudDevice] Setting ubuntu user password..."
set +x
echo "ubuntu:{ubuntu_password}" | sudo chpasswd
set -x
echo "[CloudDevice] Ubuntu user password configured"
"""


def _generate_git_token_exports(
    git_tokens: Optional[List[Dict[str, Any]]],
) -> str:
    """Generate shell export lines for supported git token environment variables."""
    envs = build_git_token_envs(git_tokens)
    if not envs:
        return ""

    export_lines = _generate_git_token_export_lines(envs)
    return "\n".join(
        [
            "# Export git tokens without shell xtrace leaking values",
            "set +x",
            export_lines,
            "set -x",
        ]
    )


def _generate_git_clone_config(
    git_tokens: Optional[List[Dict[str, Any]]],
) -> str:
    """Generate Git config with managed credentials and per-domain identities."""
    if not git_tokens:
        return ""

    payload = json.dumps(
        {"version": 1, "accounts": git_tokens},
        ensure_ascii=False,
        separators=(",", ":"),
    )

    return f"""
# Configure managed Git authentication and per-domain commit identities
set +x
export {GIT_CREDENTIALS_SECRET_ENV}={shlex.quote(payload)}
if ! {SYNC_GIT_CREDENTIALS_COMMAND}; then
  unset {GIT_CREDENTIALS_SECRET_ENV}
  set -x
  echo "[CloudDevice] Failed to configure managed Git accounts"
  exit 1
fi
unset {GIT_CREDENTIALS_SECRET_ENV}
set -x
"""


def _generate_git_token_export_lines(envs: Dict[str, str]) -> str:
    """Generate escaped export lines for git token environment variables."""
    return "\n".join(
        f'export {env_name}="{_escape_double_quoted_env_value(value)}"'
        for env_name, value in envs.items()
    )


def _escape_double_quoted_env_value(value: str) -> str:
    """Escape a value for use inside a double-quoted shell export."""
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("$", "\\$")
        .replace("`", "\\`")
    )
