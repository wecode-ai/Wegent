#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Executor main entry point.

Supports two modes:
- Local mode: WebSocket-based executor for local deployment
  - Configured via device-config.json (preferred)
  - Falls back to EXECUTOR_MODE=local env var (deprecated)
- Docker mode (default): FastAPI server for container deployment

CLI options:
- --version, -v: Print version and exit
- --config <path>: Specify config file path (default: ~/.wegent-executor/device-config.json)
  Note: In PyInstaller builds, --version is handled by hooks/rthook_version.py
  to avoid module initialization issues.
"""

import multiprocessing
import os
import sys


def _handle_version_flag() -> None:
    """Handle --version/-v flag before any other initialization.

    If the flag is present, print version and exit immediately.
    This is done before any heavy imports to ensure fast response.

    Note: In PyInstaller builds, version flag is handled earlier by the
    runtime hook (hooks/rthook_version.py) to avoid cleanup errors.
    This function serves as a fallback for non-frozen (development) mode.
    """
    # Skip if already handled by PyInstaller runtime hook
    if getattr(sys, "frozen", False):
        return

    if "--version" in sys.argv or "-v" in sys.argv:
        from executor.version import get_version

        print(get_version(), flush=True)
        sys.exit(0)


# Required for PyInstaller on macOS/Windows to prevent infinite fork
if getattr(sys, "frozen", False):
    multiprocessing.freeze_support()

    # Fix SSL certificate path for PyInstaller bundled executable
    # PyInstaller bundles certifi but Python may not find it automatically
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
    except ImportError:
        pass

# Import the shared logger
from shared.logger import setup_logger

# Use the shared logger setup function
logger = setup_logger("task_executor")


def main() -> None:
    """
    Main function for running the executor.

    Configuration is loaded from:
    1. --config argument (if provided)
    2. ~/.wegent-executor/device-config.json (default path)
    3. EXECUTOR_MODE environment variable (deprecated, for backward compatibility)

    In local mode, starts the WebSocket-based local runner.
    In Docker mode (default), starts the FastAPI server.
    """
    # Handle version flag first (before any heavy initialization)
    _handle_version_flag()

    from executor.config.device_config import (
        get_config_path_from_args,
        load_device_config,
        should_use_local_mode,
    )

    # Get config path from command line arguments
    config_path = get_config_path_from_args()

    # Determine if we should run in local mode
    if should_use_local_mode(config_path):
        # Local mode: Run WebSocket-based executor
        import asyncio

        from executor.modes.local.runner import LocalRunner

        # Load full configuration for local mode
        try:
            device_config = load_device_config(config_path)
            logger.info("Starting executor in LOCAL mode")
            logger.info(f"Device ID: {device_config.device_id}")
            logger.info(f"Device Name: {device_config.device_name}")
            logger.info(f"Backend URL: {device_config.connection.backend_url}")
            logger.info(
                f"Auth Token: {'***' if device_config.connection.auth_token else 'NOT SET'}"
            )

            # Pass config to runner
            runner = LocalRunner(device_config=device_config)
            asyncio.run(runner.start())
        except FileNotFoundError as e:
            logger.error(f"Configuration error: {e}")
            sys.exit(1)
        except Exception as e:
            logger.exception(f"Failed to start local mode: {e}")
            sys.exit(1)
    else:
        # Docker mode (default): Run FastAPI server
        # Import FastAPI dependencies only in Docker mode
        import uvicorn

        from executor.app import app

        logger.info("Starting executor in DOCKER mode")
        # Get port from environment variable, default to 10001
        port = int(os.getenv("PORT", 10001))
        uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
