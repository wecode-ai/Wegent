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
    NEVIS_MAX_DEVICES_PER_USER: int = 3

    class Config:
        env_file = ".env"
        extra = "ignore"


# Singleton instance
nevis_settings = NevisSettings()
