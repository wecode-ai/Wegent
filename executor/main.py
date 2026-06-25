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

import argparse
import asyncio
import contextlib
import logging
import multiprocessing
import os
import sys
from pathlib import Path


def _handle_upgrade_flag(args: argparse.Namespace) -> int:
    """
    Handle --upgrade flag.
    Returns exit code (0 for success, 1 for failure).
    """
    from executor.services.updater.upgrade_handler import UpgradeHandler

    # Check for verbose flag
    verbose = getattr(args, "verbose", False) or "--verbose" in sys.argv

    handler = UpgradeHandler(verbose=verbose)
    return handler.handle(args)


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


def _parse_args() -> argparse.Namespace:
    """Parse command line arguments.

    Returns:
        Parsed arguments namespace.
    """
    parser = argparse.ArgumentParser(
        description="Wegent Executor - AI-native operating system for agent teams",
        add_help=False,
    )

    # Flags that exit immediately
    parser.add_argument(
        "--version", "-v", action="store_true", help="Print version and exit"
    )
    parser.add_argument(
        "--upgrade",
        action="store_true",
        help="Check for updates and upgrade if available",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Auto-confirm upgrade without prompting",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Enable verbose logging for upgrade"
    )
    parser.add_argument(
        "--config",
        type=str,
        help="Path to config file (default: ~/.wegent-executor/device-config.json)",
    )
    parser.add_argument(
        "--app-ipc",
        action="store_true",
        help="Serve newline-delimited app IPC on stdin/stdout",
    )
    parser.add_argument(
        "--no-backend",
        action="store_true",
        help="Disable the Backend WebSocket channel when app IPC is enabled",
    )
    parser.add_argument(
        "-h", "--help", action="store_true", help="Show this help message and exit"
    )

    # Parse only known args to avoid breaking on unexpected args
    args, _ = parser.parse_known_args()
    return args


def _configure_app_ipc_stdio() -> None:
    """Keep stdout reserved for app IPC JSON messages."""
    os.environ["WEGENT_LOG_TO_STDERR"] = "1"

    loggers = [logging.getLogger()]
    for candidate in logging.Logger.manager.loggerDict.values():
        if isinstance(candidate, logging.Logger):
            loggers.append(candidate)

    for current_logger in loggers:
        for handler in current_logger.handlers:
            _redirect_stream_handler(handler)
        listener = getattr(current_logger, "_queue_listener", None)
        for handler in getattr(listener, "handlers", []) or []:
            _redirect_stream_handler(handler)


def _redirect_stream_handler(handler: logging.Handler) -> None:
    if not isinstance(handler, logging.StreamHandler):
        return
    try:
        handler.setStream(sys.stderr)
    except Exception:
        handler.stream = sys.stderr


def _load_device_config_for_mode(config_path: str | None, *, quiet_stdout: bool):
    from executor.config.device_config import load_device_config

    if quiet_stdout:
        with contextlib.redirect_stdout(sys.stderr):
            return load_device_config(config_path)
    return load_device_config(config_path)


async def _run_local_runner_with_app_ipc(runner, app_ipc_server) -> None:
    """Run Backend LocalRunner and app IPC in one executor process."""
    runtime_work_handler = getattr(runner, "runtime_work_handler", None)
    if runtime_work_handler is not None:
        await runtime_work_handler.start_codex_watcher()

    runner_task = asyncio.create_task(runner.start())
    await asyncio.sleep(0)
    try:
        await app_ipc_server.serve()
    finally:
        app_ipc_server.stop()
        runner_task.cancel()
        await asyncio.gather(runner_task, return_exceptions=True)
        if runtime_work_handler is not None:
            await runtime_work_handler.stop_codex_watcher()


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
    # Parse arguments first
    args = _parse_args()

    if args.app_ipc:
        _configure_app_ipc_stdio()

    # Handle version flag first (before any heavy initialization)
    if args.version:
        from executor.version import get_version

        print(get_version(), flush=True)
        sys.exit(0)

    # Handle upgrade flag second (before heavy imports)
    if args.upgrade:
        sys.exit(_handle_upgrade_flag(args))

    from executor.config.device_config import (
        get_config_path_from_args,
        should_use_local_mode,
    )

    # Get config path from command line arguments
    config_path = get_config_path_from_args()

    # Determine if we should run in local mode
    if args.app_ipc or should_use_local_mode(config_path):
        # Local mode: Run WebSocket-based executor
        # Load full configuration for local mode
        try:
            device_config = _load_device_config_for_mode(
                config_path,
                quiet_stdout=args.app_ipc,
            )

            # Sync device config values to global config for modules that read
            # from config directly. device_config already has env overrides applied.
            from executor.config.config import sync_device_config

            sync_device_config(device_config)

            import executor.config.config as config

            if args.app_ipc and args.no_backend:
                from executor.modes.local.app_ipc import run_app_ipc

                logger.info("Starting executor in APP IPC mode without Backend")
                asyncio.run(
                    run_app_ipc(device_id=device_config.device_id or "local-device")
                )
                return

            from executor.modes.local.runner import LocalRunner

            logger.info("Starting executor in LOCAL mode")
            logger.info(f"Device ID: {device_config.device_id}")
            logger.info(f"Device Name: {device_config.device_name}")
            logger.info(f"Backend URL: {config.WEGENT_BACKEND_URL}")
            logger.info(
                f"Auth Token: {'***' if config.WEGENT_AUTH_TOKEN else 'NOT SET'}"
            )

            runner = LocalRunner(device_config=device_config)
            if args.app_ipc:
                from executor.modes.local.app_ipc import AppIpcServer

                app_ipc_server = AppIpcServer(
                    device_id=device_config.device_id or "local-device",
                    runtime_work_handler=runner.runtime_work_handler,
                    command_handler=runner.command_handler,
                )
                runner.set_app_event_emitter(app_ipc_server.emit_event)
                logger.info("Starting executor with Backend and APP IPC channels")
                asyncio.run(_run_local_runner_with_app_ipc(runner, app_ipc_server))
            else:
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
