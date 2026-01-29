#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Executor main entry point.

Supports two modes:
- Local mode (EXECUTOR_MODE=local): WebSocket-based executor for local deployment
- Docker mode (default): FastAPI server for container deployment
"""

import multiprocessing
import os
import sys

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


def main():
    """
    Main function for running the executor.

    In local mode (EXECUTOR_MODE=local), starts the WebSocket-based local runner.
    In Docker mode (default), starts the FastAPI server.
    """
    from executor.config import config

    if config.EXECUTOR_MODE == "local":
        # Local mode: Run WebSocket-based executor
        import asyncio

        from executor.modes.local.runner import LocalRunner

        logger.info("Starting executor in LOCAL mode")
        runner = LocalRunner()
        asyncio.run(runner.start())
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
