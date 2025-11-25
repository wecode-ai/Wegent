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

# Claude Code error retry configuration
CLAUDE_ERROR_MAX_RETRIES = int(os.environ.get("CLAUDE_ERROR_MAX_RETRIES", "3"))
CLAUDE_RETRY_ERROR_PATTERNS = os.environ.get(
    "CLAUDE_RETRY_ERROR_PATTERNS",
    "Cannot read properties of undefined|ReferenceError|TypeError: Cannot read"
).split("|")

# Task cancellation configuration
CANCEL_TIMEOUT_SECONDS = int(os.environ.get("CANCEL_TIMEOUT_SECONDS", "30"))
CANCEL_RETRY_ATTEMPTS = int(os.environ.get("CANCEL_RETRY_ATTEMPTS", "3"))
CANCEL_RETRY_DELAY = int(os.environ.get("CANCEL_RETRY_DELAY", "2"))
GRACEFUL_SHUTDOWN_TIMEOUT = int(os.environ.get("GRACEFUL_SHUTDOWN_TIMEOUT", "10"))

CUSTOM_CONFIG = load_custom_config()
