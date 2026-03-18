# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Nevis cloud device configuration.

Loads Nevis Sandbox API configuration from environment variables.
"""

from pydantic_settings import BaseSettings


class NevisSettings(BaseSettings):
    """Nevis Sandbox API configuration settings."""

    # Nevis API base URL
    NEVIS_BASE_URL: str = ""

    # Manager ID for sandbox operations
    NEVIS_MANAGER_ID: str = ""

    # Default image ID for VM creation
    NEVIS_IMAGE_ID: str = ""

    # API signature token for authentication
    NEVIS_SIGNATURE: str = ""

    # Maximum number of cloud devices per user
    NEVIS_MAX_DEVICES_PER_USER: int = 1

    # Executor binary download URL for cloud devices.
    # Used when executor is not pre-installed on the VM.
    NEVIS_EXECUTOR_DOWNLOAD_URL: str = (
        "https://git.intra.weibo.com/api/v4/projects/"
        "weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/"
        "repository/files/dist%2Fwegent-executor-linux-amd64/raw?ref=master"
    )

    # Install script URL for cloud devices.
    # The script handles binary download, configuration, and executor startup.
    NEVIS_INSTALL_SCRIPT_URL: str = (
        "https://git.intra.weibo.com/api/v4/projects/"
        "weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/"
        "repository/files/dist%2Fdevice_install-and-run-wegent.sh/raw?ref=master"
    )

    # OpenClaw install script URL for cloud devices.
    # Downloaded from the same repository as the wegent install script.
    NEVIS_OPENCLAW_INSTALL_SCRIPT_URL: str = (
        "https://git.intra.weibo.com/api/v4/projects/"
        "weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/"
        "repository/files/dist%2Fdevice_install-and-run-openclaw.sh/raw?ref=master"
    )

    # Private token for accessing executor binary download URL
    NEVIS_EXECUTOR_DOWNLOAD_TOKEN: str = ""

    # Callback URL for cloud device executor to connect back to backend.
    # If not set, falls back to BACKEND_INTERNAL_URL.
    NEVIS_CALLBACK_URL: str = ""

    class Config:
        env_file = ".env"
        extra = "ignore"


# Singleton instance
nevis_settings = NevisSettings()
