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

# OpenTelemetry configuration is centralized in shared/telemetry/config.py
# Use: from shared.telemetry.config import get_otel_config
# All OTEL_* environment variables are read from there

CUSTOM_CONFIG = load_custom_config()

# ============ Local Mode Configuration ============
# Deployment mode: 'local' for local deployment via WebSocket, empty/other for Docker mode
EXECUTOR_MODE = os.environ.get("EXECUTOR_MODE", "")

# Local mode WebSocket connection settings
WEGENT_AUTH_TOKEN = os.environ.get("WEGENT_AUTH_TOKEN", "")  # WebSocket auth token
WEGENT_BACKEND_URL = os.environ.get(
    "WEGENT_BACKEND_URL", ""
)  # Backend WebSocket URL (e.g., wss://api.example.com)

# Local mode heartbeat configuration
LOCAL_HEARTBEAT_INTERVAL = int(os.environ.get("LOCAL_HEARTBEAT_INTERVAL", "30"))
LOCAL_HEARTBEAT_TIMEOUT = int(os.environ.get("LOCAL_HEARTBEAT_TIMEOUT", "90"))

# Local mode reconnection configuration
LOCAL_RECONNECT_DELAY = int(os.environ.get("LOCAL_RECONNECT_DELAY", "1"))
LOCAL_RECONNECT_MAX_DELAY = int(os.environ.get("LOCAL_RECONNECT_MAX_DELAY", "30"))
