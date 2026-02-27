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

    # Private token for accessing executor binary download URL
    NEVIS_EXECUTOR_DOWNLOAD_TOKEN: str = ""

    # Comma-separated list of usernames allowed to create cloud devices.
    # If empty, all users are allowed.
    NEVIS_CREATE_WHITELIST: str = ""

    class Config:
        env_file = ".env"
        extra = "ignore"

    def get_create_whitelist(self) -> list[str]:
        """Get list of usernames allowed to create cloud devices.

        Returns:
            List of usernames from NEVIS_CREATE_WHITELIST.
            Empty list means all users are allowed.
        """
        if not self.NEVIS_CREATE_WHITELIST:
            return []
        return [
            username.strip()
            for username in self.NEVIS_CREATE_WHITELIST.split(",")
            if username.strip()
        ]

    def can_create_cloud_device(self, username: str) -> bool:
        """Check if a user can create cloud devices.

        Args:
            username: The username to check.

        Returns:
            True if the user is allowed to create cloud devices.
            If whitelist is empty, all users are allowed.
        """
        whitelist = self.get_create_whitelist()
        if not whitelist:
            return True
        return username in whitelist


# Singleton instance
nevis_settings = NevisSettings()
