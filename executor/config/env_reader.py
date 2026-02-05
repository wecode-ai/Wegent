# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Environment variable reader with file-based fallback.

This module provides a unified way to read configuration values that supports:
1. Environment variables (os.environ)
2. File-based configuration as fallback

The reading priority is:
1. Environment variable (os.environ)
2. File at /root/.wegent/.config/{key}
3. Default value
"""

import json
import os
from typing import Any, Dict, Optional

from shared.logger import setup_logger

logger = setup_logger(__name__)

# Default config directory for file-based config
DEFAULT_CONFIG_DIR = "/root/.wegent/.config"


def get_config_dir() -> str:
    """Get the configuration directory path."""
    return os.getenv("WEGENT_CONFIG_DIR", DEFAULT_CONFIG_DIR)


def get_env(key: str, default: Optional[str] = None) -> Optional[str]:
    """
    Get configuration value with file-based fallback.

    Priority:
    1. Environment variable (os.environ)
    2. File at {config_dir}/{key.lower()}
    3. Default value

    Args:
        key: Configuration key (e.g., "TASK_INFO", "AUTH_TOKEN")
        default: Default value if not found

    Returns:
        Configuration value or default
    """
    # 1. Try environment variable first
    value = os.environ.get(key)
    if value is not None:
        return value

    # 2. Try file-based config
    config_dir = get_config_dir()
    file_path = os.path.join(config_dir, key.lower())

    if os.path.exists(file_path):
        try:
            with open(file_path, "r") as f:
                content = f.read().strip()
                if content:
                    logger.debug(f"Read config '{key}' from file: {file_path}")
                    return content
        except Exception as e:
            logger.warning(f"Failed to read config file {file_path}: {e}")

    # 3. Return default
    return default


def get_env_json(
    key: str, default: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    """
    Get JSON configuration value with file-based fallback.

    Args:
        key: Configuration key
        default: Default value if not found or invalid JSON

    Returns:
        Parsed JSON dict or default
    """
    value = get_env(key)
    if value is None:
        return default

    try:
        return json.loads(value)
    except json.JSONDecodeError as e:
        logger.warning(f"Invalid JSON for config '{key}': {e}")
        return default


def get_task_info() -> Optional[Dict[str, Any]]:
    """
    Get task information from environment or file.

    Returns:
        Task info dict or None
    """
    return get_env_json("TASK_INFO")


def get_auth_token() -> Optional[str]:
    """Get authentication token."""
    return get_env("AUTH_TOKEN")


def get_task_id() -> Optional[str]:
    """Get task ID."""
    return get_env("TASK_ID")


def get_executor_name() -> Optional[str]:
    """Get executor name."""
    return get_env("EXECUTOR_NAME")


def get_callback_url() -> Optional[str]:
    """Get callback URL."""
    return get_env("CALLBACK_URL")


def get_heartbeat_base_url() -> str:
    """
    Get executor manager heartbeat base URL.

    Returns:
        Heartbeat base URL or empty string if not configured
    """
    return get_env("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL", "")


def get_task_api_domain() -> str:
    """
    Get task API domain.

    Returns:
        Task API domain or empty string if not configured
    """
    return get_env("TASK_API_DOMAIN", "")
