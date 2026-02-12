# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device configuration module for executor.

This module provides a unified configuration system for device settings,
replacing the EXECUTOR_MODE environment variable with a config file approach.

Configuration priority (highest to lowest):
1. Environment variables
2. Config file (~/.wegent-executor/device-config.json)
3. Default values

The config file is auto-generated on first startup if it doesn't exist.
"""

import json
import logging
import os
import platform
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ExecutorMode(str, Enum):
    """Executor deployment mode."""

    LOCAL = "local"
    DOCKER = "docker"


class DeviceType(str, Enum):
    """Device type enumeration."""

    LOCAL = "local"
    CLOUD = "cloud"


@dataclass
class ConnectionConfig:
    """Connection configuration for device-backend communication."""

    backend_url: str = ""
    auth_token: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "backend_url": self.backend_url,
            "auth_token": self.auth_token,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ConnectionConfig":
        """Create from dictionary."""
        return cls(
            backend_url=data.get("backend_url", ""),
            auth_token=data.get("auth_token", ""),
        )


@dataclass
class LoggingConfig:
    """Logging configuration for the executor."""

    level: str = "info"
    max_size_mb: int = 10
    backup_count: int = 5

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "level": self.level,
            "max_size_mb": self.max_size_mb,
            "backup_count": self.backup_count,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LoggingConfig":
        """Create from dictionary."""
        return cls(
            level=data.get("level", "info"),
            max_size_mb=data.get("max_size_mb", 10),
            backup_count=data.get("backup_count", 5),
        )


@dataclass
class DeviceConfig:
    """Device configuration for executor.

    This configuration controls how the executor identifies itself
    and connects to the backend.
    """

    # Executor mode: 'local' or 'docker'
    mode: str = "local"

    # Device type: 'local' or 'cloud'
    device_type: str = "local"

    # Unique device identifier (auto-generated UUID if not specified)
    device_id: str = ""

    # Device display name (auto-generated based on OS if not specified)
    device_name: str = ""

    # Device capabilities/tags for task routing
    capabilities: List[str] = field(default_factory=list)

    # Maximum concurrent tasks this device can handle
    max_concurrent_tasks: int = 5

    # Connection settings
    connection: ConnectionConfig = field(default_factory=ConnectionConfig)

    # Logging settings
    logging: LoggingConfig = field(default_factory=LoggingConfig)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "mode": self.mode,
            "device_type": self.device_type,
            "device_id": self.device_id,
            "device_name": self.device_name,
            "capabilities": self.capabilities,
            "max_concurrent_tasks": self.max_concurrent_tasks,
            "connection": self.connection.to_dict(),
            "logging": self.logging.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DeviceConfig":
        """Create from dictionary."""
        connection_data = data.get("connection", {})
        logging_data = data.get("logging", {})

        return cls(
            mode=data.get("mode", "local"),
            device_type=data.get("device_type", "local"),
            device_id=data.get("device_id", ""),
            device_name=data.get("device_name", ""),
            capabilities=data.get("capabilities", []),
            max_concurrent_tasks=data.get("max_concurrent_tasks", 5),
            connection=ConnectionConfig.from_dict(connection_data),
            logging=LoggingConfig.from_dict(logging_data),
        )


def _get_default_device_name(device_id: str) -> str:
    """Generate default device name based on OS type and device ID.

    Returns:
        Device name in format '{OS}-Device-{last12chars}' (e.g., 'macOS-Device-6296f3b9ccd8')
    """
    system = platform.system()
    if system == "Darwin":
        os_name = "macOS"
    elif system == "Linux":
        os_name = "Linux"
    elif system == "Windows":
        os_name = "Windows"
    else:
        os_name = system

    # Append last 12 characters of device_id
    device_id_suffix = device_id[-12:] if len(device_id) >= 12 else device_id
    return f"{os_name}-Device-{device_id_suffix}"


def _get_default_config_path() -> Path:
    """Get the default config file path.

    Returns:
        Path to ~/.wegent-executor/device-config.json
    """
    home = Path.home()
    return home / ".wegent-executor" / "device-config.json"


def _create_default_config() -> DeviceConfig:
    """Create a default device configuration.

    Reads connection settings from environment variables if available.

    Returns:
        DeviceConfig with default values
    """
    device_id = str(uuid.uuid4())
    return DeviceConfig(
        mode="local",
        device_type="local",
        device_id=device_id,
        device_name=_get_default_device_name(device_id),
        capabilities=[],
        max_concurrent_tasks=5,
        connection=ConnectionConfig(
            backend_url=os.environ.get("WEGENT_BACKEND_URL", ""),
            auth_token=os.environ.get("WEGENT_AUTH_TOKEN", ""),
        ),
        logging=LoggingConfig(
            level=os.environ.get("LOG_LEVEL", "info").lower(),
            max_size_mb=10,
            backup_count=5,
        ),
    )


def _apply_env_overrides(config: DeviceConfig) -> tuple[DeviceConfig, bool]:
    """Apply environment variable overrides to config.

    Environment variables take precedence over config file values.
    If config value is empty and env var has value, mark as needing save.

    Args:
        config: Base configuration to override

    Returns:
        Tuple of (config with overrides applied, should_save flag)
        should_save is True only when filling empty config values from env vars
    """
    should_save = False

    # Connection overrides
    if os.environ.get("WEGENT_BACKEND_URL"):
        env_value = os.environ["WEGENT_BACKEND_URL"]
        if not config.connection.backend_url:
            # Config is empty, save env value to config
            should_save = True
        config.connection.backend_url = env_value

    if os.environ.get("WEGENT_AUTH_TOKEN"):
        env_value = os.environ["WEGENT_AUTH_TOKEN"]
        if not config.connection.auth_token:
            # Config is empty, save env value to config
            should_save = True
        config.connection.auth_token = env_value

    # Device overrides
    if os.environ.get("DEVICE_ID"):
        env_value = os.environ["DEVICE_ID"]
        if not config.device_id:
            should_save = True
        config.device_id = env_value

    if os.environ.get("DEVICE_NAME"):
        env_value = os.environ["DEVICE_NAME"]
        if not config.device_name:
            should_save = True
        config.device_name = env_value

    # Logging overrides (don't save, just override)
    if os.environ.get("LOG_LEVEL"):
        config.logging.level = os.environ["LOG_LEVEL"].lower()

    return config, should_save


def load_device_config(config_path: Optional[str] = None) -> DeviceConfig:
    """Load device configuration from file or create default.

    Configuration loading order:
    1. If --config argument provided, load from that path
    2. Otherwise, check default path (~/.wegent-executor/device-config.json)
    3. If no config exists, auto-generate default config and save it
    4. Apply environment variable overrides

    Args:
        config_path: Optional path to config file (from --config argument)

    Returns:
        DeviceConfig instance

    Raises:
        FileNotFoundError: If specified config_path doesn't exist
        json.JSONDecodeError: If config file contains invalid JSON
    """
    # Determine config file path
    if config_path:
        path = Path(config_path)
        if not path.exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")
    else:
        path = _get_default_config_path()

    # Check for EXECUTOR_MODE migration scenario
    executor_mode_env = os.environ.get("EXECUTOR_MODE", "")

    if path.exists():
        # Load existing config
        logger.info(f"Loading config from: {path}")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        config = DeviceConfig.from_dict(data)

        # Warn about EXECUTOR_MODE being ignored
        if executor_mode_env:
            logger.warning(
                f"EXECUTOR_MODE environment variable is set to '{executor_mode_env}' "
                f"but will be ignored because config file exists at {path}. "
                "The config file takes precedence."
            )
    else:
        # No config file exists
        if executor_mode_env == "local":
            # Migration scenario: EXECUTOR_MODE=local but no config file
            logger.info(
                "Detected EXECUTOR_MODE=local without config file. "
                "Migrating to config file approach..."
            )
            config = _create_default_config()
            _save_config(config, path)
            print(
                f"\n[Migration] Config file created: {path}\n"
                "You can modify this file to customize your device settings.\n"
                "The EXECUTOR_MODE environment variable is now deprecated.\n"
            )
        elif config_path:
            # Explicit config path was given but doesn't exist
            raise FileNotFoundError(f"Config file not found: {config_path}")
        else:
            # First-time setup: create default config
            config = _create_default_config()
            _save_config(config, path)
            print(
                f"\nConfig file created: {path}\n"
                "You can modify this file to customize your device settings.\n"
            )

    # Apply environment variable overrides (env vars take precedence)
    config, should_save = _apply_env_overrides(config)

    # Save config if empty values were filled from env vars
    if should_save:
        logger.info("Saving env var values to config file (filling empty fields)...")
        _save_config(config, path)

    return config


def _save_config(config: DeviceConfig, path: Path) -> None:
    """Save configuration to file.

    Args:
        config: Configuration to save
        path: Path to save to
    """
    # Ensure parent directory exists
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(config.to_dict(), f, indent=2, ensure_ascii=False)

    logger.info(f"Saved config to: {path}")


def should_use_local_mode(config_path: Optional[str] = None) -> bool:
    """Check if executor should run in local mode.

    This function determines the executor mode by checking:
    1. Config file (if exists)
    2. EXECUTOR_MODE environment variable (for backward compatibility)

    Args:
        config_path: Optional path to config file

    Returns:
        True if local mode should be used
    """
    # Check config file first
    if config_path:
        path = Path(config_path)
    else:
        path = _get_default_config_path()

    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("mode", "local") == "local"
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to read config file {path}: {e}")

    # Fall back to environment variable
    return os.environ.get("EXECUTOR_MODE", "") == "local"


def get_config_path_from_args() -> Optional[str]:
    """Extract --config argument from command line.

    Returns:
        Config file path if --config was specified, None otherwise
    """
    import sys

    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--config" and i + 1 < len(args):
            return args[i + 1]
        elif arg.startswith("--config="):
            return arg.split("=", 1)[1]

    return None
