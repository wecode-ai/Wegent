# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configuration management for executor_manager services.

This module centralizes all configuration values that were previously
scattered across multiple service files, making it easier to manage
and modify settings.
"""

import os

# Route prefix constant - use this everywhere to avoid typos
ROUTE_PREFIX = "/executor-manager"

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class RedisConfig:
    """Redis connection configuration."""

    url: str = field(
        default_factory=lambda: os.getenv("REDIS_URL", "redis://localhost:6379/0")
    )
    socket_timeout: float = 5.0
    connect_timeout: float = 2.0
    encoding: str = "utf-8"
    decode_responses: bool = True


@dataclass(frozen=True)
class TimeoutConfig:
    """Timeout configuration for various operations."""

    # Sandbox timeouts
    sandbox_default: int = 1800  # 30 minutes
    execution_default: int = 600  # 10 minutes
    container_ready: int = field(
        default_factory=lambda: int(os.getenv("CONTAINER_READY_TIMEOUT", "20"))
    )

    # Heartbeat timeouts
    heartbeat_key_ttl: int = 30
    heartbeat_timeout: int = field(
        default_factory=lambda: int(os.getenv("HEARTBEAT_TIMEOUT", "60"))
    )
    heartbeat_check_interval: int = field(
        default_factory=lambda: int(os.getenv("HEARTBEAT_CHECK_INTERVAL", "30"))
    )

    # HTTP timeouts
    http_health_check: float = 2.0
    http_execution_request: float = 30.0
    http_container_wait: float = 5.0

    # Redis TTL
    redis_ttl: int = 86400  # 24 hours


@dataclass(frozen=True)
class RetryConfig:
    """Retry configuration for callback operations."""

    callback_max_retries: int = field(
        default_factory=lambda: int(os.getenv("SUBAGENT_CALLBACK_MAX_RETRIES", "3"))
    )
    callback_retry_delay: float = field(
        default_factory=lambda: float(os.getenv("SUBAGENT_CALLBACK_RETRY_DELAY", "2"))
    )
    callback_timeout: float = field(
        default_factory=lambda: float(os.getenv("SUBAGENT_CALLBACK_TIMEOUT", "10.0"))
    )


@dataclass(frozen=True)
class ExecutorConfig:
    """Executor-related configuration."""

    executor_binding_ttl: int = field(
        default_factory=lambda: int(os.getenv("SUBAGENT_EXECUTOR_BINDING_TTL", "86400"))
    )
    executor_image: str = field(default_factory=lambda: os.getenv("EXECUTOR_IMAGE", ""))
    callback_url: str = field(
        default_factory=lambda: os.getenv(
            "EXECUTOR_MANAGER_CALLBACK_URL",
            "http://localhost:8001/executor-manager/callback",
        )
    )
    # Host address for reaching executor containers
    # In Docker deployment, this should be the host machine's IP or "host.docker.internal"
    docker_host: str = field(
        default_factory=lambda: os.getenv("DOCKER_HOST_ADDR", "localhost")
    )


@dataclass
class AppConfig:
    """Application-wide configuration container."""

    redis: RedisConfig = field(default_factory=RedisConfig)
    timeout: TimeoutConfig = field(default_factory=TimeoutConfig)
    retry: RetryConfig = field(default_factory=RetryConfig)
    executor: ExecutorConfig = field(default_factory=ExecutorConfig)


# Global configuration instance
_config: Optional[AppConfig] = None


def get_config() -> AppConfig:
    """Get the global application configuration.

    Returns:
        AppConfig instance with all configuration values
    """
    global _config
    if _config is None:
        _config = AppConfig()
    return _config


def reset_config() -> None:
    """Reset the global configuration.

    This is primarily useful for testing purposes.
    """
    global _config
    _config = None
