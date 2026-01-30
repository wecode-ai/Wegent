# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# coding: utf-8
import os

from executor.config.config_loader import load_custom_config

"""
Global configuration for workspace paths and other shared settings.
"""

WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace/")
CALLBACK_URL = os.environ.get("CALLBACK_URL", "")

# Agno Agent default headers configuration
EXECUTOR_ENV = os.environ.get("EXECUTOR_ENV", "{}")
DEBUG_RUN = os.environ.get("DEBUG_RUN", "")

# Task cancellation configuration
CANCEL_TIMEOUT_SECONDS = int(os.environ.get("CANCEL_TIMEOUT_SECONDS", "30"))
CANCEL_RETRY_ATTEMPTS = int(os.environ.get("CANCEL_RETRY_ATTEMPTS", "3"))
CANCEL_RETRY_DELAY = int(os.environ.get("CANCEL_RETRY_DELAY", "2"))
GRACEFUL_SHUTDOWN_TIMEOUT = int(os.environ.get("GRACEFUL_SHUTDOWN_TIMEOUT", "10"))

# Custom instruction files configuration
# These files will be automatically loaded from the project root and merged with systemPrompt
# Supports relative paths from project root (e.g., ".cursorrules", ".cursor/rules", "docs/.ai-guidelines")
# Files are merged in the order specified in this list
# Non-existent files are silently skipped
CUSTOM_INSTRUCTION_FILES = os.getenv(
    "CUSTOM_INSTRUCTION_FILES", ".cursorrules,.windsurfrules"
).split(",")

# Skill cache configuration
# When True (default), the skills directory (~/.claude/skills/) is cleared before deploying new skills
# When False, only replace skills with the same name, preserving other cached skills
SKILL_CLEAR_CACHE = os.environ.get("SKILL_CLEAR_CACHE", "true").lower() in (
    "true",
    "1",
    "yes",
)

# OpenTelemetry configuration is centralized in shared/telemetry/config.py
# Use: from shared.telemetry.config import get_otel_config
# All OTEL_* environment variables are read from there

CUSTOM_CONFIG = load_custom_config()

# ============ Local Mode Configuration ============
# Default values for local mode configuration
DEFAULT_LOCAL_HEARTBEAT_INTERVAL = 30
DEFAULT_LOCAL_HEARTBEAT_TIMEOUT = 90
DEFAULT_LOCAL_RECONNECT_DELAY = 1
DEFAULT_LOCAL_RECONNECT_MAX_DELAY = 30


def _get_int_env(name: str, default: int) -> int:
    """Safely parse an integer from environment variable.

    Args:
        name: Environment variable name.
        default: Default value if not set or invalid.

    Returns:
        The parsed integer or default value.
    """
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


# Deployment mode: 'local' for local deployment via WebSocket, empty/other for Docker mode
EXECUTOR_MODE = os.environ.get("EXECUTOR_MODE", "")

# Local mode WebSocket connection settings
WEGENT_AUTH_TOKEN = os.environ.get("WEGENT_AUTH_TOKEN", "")  # WebSocket auth token
WEGENT_BACKEND_URL = os.environ.get(
    "WEGENT_BACKEND_URL", ""
)  # Backend WebSocket URL (e.g., http://localhost:8000)

# Local mode heartbeat configuration
# Only parse from env when in local mode to avoid unnecessary overhead
LOCAL_HEARTBEAT_INTERVAL = _get_int_env(
    "LOCAL_HEARTBEAT_INTERVAL", DEFAULT_LOCAL_HEARTBEAT_INTERVAL
)
LOCAL_HEARTBEAT_TIMEOUT = _get_int_env(
    "LOCAL_HEARTBEAT_TIMEOUT", DEFAULT_LOCAL_HEARTBEAT_TIMEOUT
)

# Local mode reconnection configuration
LOCAL_RECONNECT_DELAY = _get_int_env(
    "LOCAL_RECONNECT_DELAY", DEFAULT_LOCAL_RECONNECT_DELAY
)
LOCAL_RECONNECT_MAX_DELAY = _get_int_env(
    "LOCAL_RECONNECT_MAX_DELAY", DEFAULT_LOCAL_RECONNECT_MAX_DELAY
)

# Local mode home directory
# All local mode data (workspace, logs, cache) will be stored under this directory
WEGENT_EXECUTOR_HOME = os.environ.get(
    "WEGENT_EXECUTOR_HOME", os.path.expanduser("~/.wegent-executor")
)

# Local mode workspace root directory
# This is where tasks will be executed and code will be cloned
LOCAL_WORKSPACE_ROOT = os.environ.get(
    "LOCAL_WORKSPACE_ROOT", os.path.join(WEGENT_EXECUTOR_HOME, "workspace")
)


def get_workspace_root() -> str:
    """Get the workspace root directory based on executor mode.

    Returns:
        For local mode: LOCAL_WORKSPACE_ROOT (~/.wegent-executor/workspace)
        For docker mode: WORKSPACE_ROOT (/workspace/)
    """
    if EXECUTOR_MODE == "local":
        return LOCAL_WORKSPACE_ROOT
    return WORKSPACE_ROOT


# Local mode logging configuration
# Log files will be stored in this directory with rotation
WEGENT_EXECUTOR_LOG_DIR = os.environ.get(
    "WEGENT_EXECUTOR_LOG_DIR", os.path.join(WEGENT_EXECUTOR_HOME, "logs")
)
WEGENT_EXECUTOR_LOG_FILE = os.environ.get("WEGENT_EXECUTOR_LOG_FILE", "executor.log")
WEGENT_EXECUTOR_LOG_MAX_SIZE = _get_int_env("WEGENT_EXECUTOR_LOG_MAX_SIZE", 10)  # MB
WEGENT_EXECUTOR_LOG_BACKUP_COUNT = _get_int_env("WEGENT_EXECUTOR_LOG_BACKUP_COUNT", 5)
