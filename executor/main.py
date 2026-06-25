#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Executor main entry point.

Supports three startup paths:
- Local sidecar mode (default): local app IPC over a sidecar socket, no Backend
- Local Backend mode: socket IPC plus WebSocket executor when WEGENT_BACKEND_URL is configured
- Docker mode: FastAPI server when EXECUTOR_MODE=docker is explicit

CLI options:
- --version, -v: Print version and exit
- --config <path>: Specify config file path (default: ~/.wegent-executor/device-config.json)
  Note: In PyInstaller builds, --version is handled by hooks/rthook_version.py
  to avoid module initialization issues.
"""

import argparse
import asyncio
import logging
import multiprocessing
import os
import sys
from pathlib import Path
from typing import Any


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
        "-h", "--help", action="store_true", help="Show this help message and exit"
    )

    # Parse only known args to avoid breaking on unexpected args
    args, _ = parser.parse_known_args()
    return args


def _load_device_config_for_mode(config_path: str | None):
    from executor.config.device_config import load_device_config

    return load_device_config(config_path)


def _configure_local_file_logging() -> None:
    """Write local sidecar executor logs to the standard local executor log file."""
    import executor.config.config as config
    from shared.logger import configure_file_logging

    log_dir = Path(config.WEGENT_EXECUTOR_LOG_DIR).expanduser()
    log_file = log_dir / config.WEGENT_EXECUTOR_LOG_FILE
    max_bytes = config.WEGENT_EXECUTOR_LOG_MAX_SIZE * 1024 * 1024
    backup_count = config.WEGENT_EXECUTOR_LOG_BACKUP_COUNT
    log_level = (
        logging.DEBUG
        if os.environ.get("LOG_LEVEL", "").upper() == "DEBUG"
        else logging.INFO
    )

    configure_file_logging(
        str(log_file),
        max_bytes=max_bytes,
        backup_count=backup_count,
        level=log_level,
    )
    logger.info("File logging enabled: %s", log_file)


def _read_existing_device_config(config_path: str | None) -> dict[str, Any]:
    from executor.config.device_config import _get_default_config_path

    path = Path(config_path) if config_path else _get_default_config_path()
    if not path.exists():
        return {}

    try:
        import json

        with open(path, "r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception:
        return {}

    return data if isinstance(data, dict) else {}


def _configured_backend_url(config_path: str | None) -> str:
    env_url = os.environ.get("WEGENT_BACKEND_URL", "").strip()
    if env_url:
        return env_url

    connection = _read_existing_device_config(config_path).get("connection", {})
    if not isinstance(connection, dict):
        return ""
    backend_url = connection.get("backend_url")
    return backend_url.strip() if isinstance(backend_url, str) else ""


def _configured_executor_mode(config_path: str | None) -> str:
    env_mode = os.environ.get("EXECUTOR_MODE", "").strip().lower()
    if env_mode:
        return env_mode

    mode = _read_existing_device_config(config_path).get("mode")
    return mode.strip().lower() if isinstance(mode, str) else ""


def _should_run_docker_server(config_path: str | None) -> bool:
    return _configured_executor_mode(config_path) == "docker"


def _should_run_local_mode(config_path: str | None) -> bool:
    return not _should_run_docker_server(config_path)


def _has_backend_connection(device_config: Any) -> bool:
    return bool(getattr(device_config.connection, "backend_url", "").strip())


def _should_connect_backend(device_config: Any) -> bool:
    """Connect Backend when a remote address is configured."""
    return _has_backend_connection(device_config)


async def _run_local_runner_with_app_ipc(
    runner,
    app_ipc_server,
) -> None:
    """Run Backend LocalRunner and local app IPC socket in one executor process."""
    runtime_work_handler = getattr(runner, "runtime_work_handler", None)
    if runtime_work_handler is not None:
        await runtime_work_handler.start_codex_watcher()

    runner_task = asyncio.create_task(runner.start())
    runner_task.add_done_callback(_log_runner_task_result)
    await asyncio.sleep(0)
    try:
        await app_ipc_server.serve_forever()
    finally:
        app_ipc_server.stop()
        await app_ipc_server.wait_closed()
        runner_task.cancel()
        await asyncio.gather(runner_task, return_exceptions=True)

        if runtime_work_handler is not None:
            await runtime_work_handler.stop_codex_watcher()


def _log_runner_task_result(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        task.result()
    except Exception:
        logger.exception("Local backend runner stopped unexpectedly")


async def _run_backend_runner(device_config: Any, app_event_emitter: Any) -> None:
    """Start the optional Backend runner without blocking local app IPC."""
    try:
        from executor.modes.local.runner import LocalRunner

        runner = LocalRunner(
            device_config=device_config,
            app_event_emitter=app_event_emitter,
        )
        await runner.start()
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Optional Backend runner failed")


async def _run_app_ipc_sidecar_with_backend(
    device_config: Any,
    app_ipc_server: Any,
) -> None:
    """Run app IPC immediately and attach Backend connectivity in the background."""
    from executor.modes.local.app_ipc import _attach_runtime_work_handler

    if not await app_ipc_server.start():
        return

    runtime_handler_task = asyncio.create_task(
        _attach_runtime_work_handler(app_ipc_server)
    )

    backend_task = asyncio.create_task(
        _run_backend_runner(device_config, app_ipc_server.emit_event)
    )
    backend_task.add_done_callback(_log_runner_task_result)

    try:
        await app_ipc_server.wait_serving()
    finally:
        app_ipc_server.stop()
        await app_ipc_server.wait_closed()
        backend_task.cancel()
        runtime_handler_task.cancel()
        await asyncio.gather(backend_task, return_exceptions=True)
        await asyncio.gather(runtime_handler_task, return_exceptions=True)


def main() -> None:
    """
    Main function for running the executor.

    Configuration is loaded from:
    1. --config argument (if provided)
    2. ~/.wegent-executor/device-config.json (default path)
    3. EXECUTOR_MODE environment variable (deprecated, for backward compatibility)

    Without a Backend URL, starts the local app IPC sidecar socket.
    With a Backend URL, starts the WebSocket-based local runner.
    In explicit Docker mode, starts the FastAPI server.
    """
    # Parse arguments first
    args = _parse_args()

    # Handle version flag first (before any heavy initialization)
    if args.version:
        from executor.version import get_version

        print(get_version(), flush=True)
        sys.exit(0)

    # Handle upgrade flag second (before heavy imports)
    if args.upgrade:
        sys.exit(_handle_upgrade_flag(args))

    from executor.config.device_config import get_config_path_from_args

    # Get config path from command line arguments
    config_path = get_config_path_from_args()

    # Determine if we should run in local mode
    if _should_run_local_mode(config_path):
        # Local mode: Run WebSocket-based executor
        # Load full configuration for local mode
        try:
            device_config = _load_device_config_for_mode(config_path)

            # Sync device config values to global config for modules that read
            # from config directly. device_config already has env overrides applied.
            from executor.config.config import sync_device_config

            sync_device_config(device_config)
            _configure_local_file_logging()

            import executor.config.config as config

            backend_enabled = _should_connect_backend(device_config)

            if not backend_enabled:
                from executor.modes.local.app_ipc import run_app_ipc_sidecar

                logger.info(
                    "Starting executor in local app IPC sidecar mode without Backend"
                )
                asyncio.run(
                    run_app_ipc_sidecar(
                        device_id=device_config.device_id or "local-device"
                    )
                )
                return

            logger.info("Starting executor in LOCAL mode")
            logger.info(f"Device ID: {device_config.device_id}")
            logger.info(f"Device Name: {device_config.device_name}")
            logger.info(f"Backend URL: {config.WEGENT_BACKEND_URL}")
            logger.info(
                f"Auth Token: {'***' if config.WEGENT_AUTH_TOKEN else 'NOT SET'}"
            )

            from executor.modes.local.app_ipc import AppIpcServer

            app_ipc_server = AppIpcServer(
                device_id=device_config.device_id or "local-device",
            )
            logger.info(
                "Starting app IPC sidecar socket with optional Backend runner in background"
            )
            asyncio.run(
                _run_app_ipc_sidecar_with_backend(device_config, app_ipc_server)
            )
        except FileNotFoundError as e:
            logger.error(f"Configuration error: {e}")
            sys.exit(1)
        except Exception as e:
            logger.exception(f"Failed to start local mode: {e}")
            sys.exit(1)
    else:
        if not _should_run_docker_server(config_path):
            logger.error(
                "Executor mode is not configured for Docker. Set EXECUTOR_MODE=docker "
                "to start the FastAPI executor server."
            )
            sys.exit(1)

        # Docker mode: Run FastAPI server
        # Import FastAPI dependencies only in Docker mode
        import uvicorn

        from executor.app import app

        logger.info("Starting executor in DOCKER mode")
        # Get port from environment variable, default to 10001
        port = int(os.getenv("PORT", 10001))
        uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
