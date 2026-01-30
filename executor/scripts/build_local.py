#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Build script for local executor binary.

This script uses PyInstaller to create a standalone executable for the
local executor mode. The binary can be distributed without requiring
Python or dependencies to be installed.

Usage:
    cd executor
    uv sync --group build
    uv run python scripts/build_local.py

Output:
    dist/wegent-executor (macOS/Linux)
    dist/wegent-executor.exe (Windows)
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def get_project_root() -> Path:
    """Get the project root directory (Wegent/)."""
    return Path(__file__).parent.parent.parent


def get_executor_root() -> Path:
    """Get the executor directory."""
    return Path(__file__).parent.parent


def clean_build_artifacts():
    """Clean previous build artifacts."""
    executor_root = get_executor_root()
    dirs_to_clean = [
        executor_root / "build",
        executor_root / "dist",
    ]
    files_to_clean = [
        executor_root / "wegent-executor.spec",
    ]

    for dir_path in dirs_to_clean:
        if dir_path.exists():
            print(f"Cleaning {dir_path}...")
            shutil.rmtree(dir_path)

    for file_path in files_to_clean:
        if file_path.exists():
            print(f"Removing {file_path}...")
            file_path.unlink()


def build_executable():
    """Build the executable using PyInstaller."""
    project_root = get_project_root()
    executor_root = get_executor_root()

    # Change to project root for correct imports
    os.chdir(project_root)

    # Determine output name based on platform
    if platform.system() == "Windows":
        output_name = "wegent-executor.exe"
    else:
        output_name = "wegent-executor"

    # PyInstaller command
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--name=wegent-executor",
        f"--distpath={executor_root / 'dist'}",
        f"--workpath={executor_root / 'build'}",
        f"--specpath={executor_root}",
        # Add project root to Python path
        f"--paths={project_root}",
        # Hidden imports for dependencies
        "--hidden-import=executor",
        "--hidden-import=executor.config",
        "--hidden-import=executor.modes",
        "--hidden-import=executor.modes.local",
        "--hidden-import=executor.modes.local.runner",
        "--hidden-import=executor.agents",
        "--hidden-import=executor.agents.claude_code",
        "--hidden-import=shared",
        "--hidden-import=shared.logger",
        "--hidden-import=shared.status",
        # Socket.IO and related
        "--hidden-import=socketio",
        "--hidden-import=socketio.asyncio_client",
        "--hidden-import=engineio",
        "--hidden-import=engineio.async_client",
        "--hidden-import=engineio.async_drivers.aiohttp",
        # aiohttp and related (for Socket.IO transport)
        "--hidden-import=aiohttp",
        "--hidden-import=aiohttp.web",
        "--hidden-import=aiohttp.client",
        "--hidden-import=aiohttp.connector",
        "--hidden-import=aiohttp.http",
        "--hidden-import=aiohttp.http_parser",
        "--hidden-import=aiohttp.http_writer",
        "--hidden-import=aiohttp.streams",
        "--hidden-import=aiohttp.payload",
        "--hidden-import=aiohttp.resolver",
        "--hidden-import=aiohttp.cookiejar",
        "--hidden-import=aiohttp.tracing",
        "--hidden-import=aiohttp.client_exceptions",
        "--hidden-import=aiohttp.client_reqrep",
        "--hidden-import=aiohttp.client_ws",
        "--hidden-import=aiohttp.formdata",
        "--hidden-import=aiohttp.helpers",
        "--hidden-import=aiohttp.multipart",
        "--hidden-import=aiohttp.web_app",
        "--hidden-import=aiohttp.web_exceptions",
        "--hidden-import=aiohttp.web_middlewares",
        "--hidden-import=aiohttp.web_protocol",
        "--hidden-import=aiohttp.web_request",
        "--hidden-import=aiohttp.web_response",
        "--hidden-import=aiohttp.web_routedef",
        "--hidden-import=aiohttp.web_runner",
        "--hidden-import=aiohttp.web_server",
        "--hidden-import=aiohttp.web_urldispatcher",
        "--hidden-import=aiohttp.web_ws",
        "--hidden-import=aiohttp.abc",
        "--hidden-import=aiohttp.base_protocol",
        "--hidden-import=aiohttp.client_proto",
        "--hidden-import=aiohttp.locks",
        "--hidden-import=aiohttp.log",
        "--hidden-import=aiohttp.typedefs",
        "--hidden-import=aiohttp._helpers",
        "--hidden-import=aiohttp._http_parser",
        "--hidden-import=aiohttp._http_writer",
        "--hidden-import=aiohttp._websocket",
        # aiohttp dependencies
        "--hidden-import=aiohappyeyeballs",
        "--hidden-import=multidict",
        "--hidden-import=yarl",
        "--hidden-import=frozenlist",
        "--hidden-import=propcache",
        "--hidden-import=async_timeout",
        "--hidden-import=aiosignal",
        "--hidden-import=attrs",
        # Async libraries
        "--hidden-import=asyncio",
        "--hidden-import=anyio",
        "--hidden-import=anyio._backends",
        "--hidden-import=anyio._backends._asyncio",
        # Claude Code SDK
        "--hidden-import=claude_code_sdk",
        # MCP dependencies (required by claude_agent_sdk -> mcp)
        "--hidden-import=starlette",
        "--hidden-import=starlette.applications",
        "--hidden-import=starlette.responses",
        "--hidden-import=starlette.routing",
        "--hidden-import=starlette.middleware",
        "--hidden-import=starlette.requests",
        "--hidden-import=starlette.websockets",
        "--hidden-import=starlette.staticfiles",
        "--hidden-import=starlette.templating",
        "--hidden-import=starlette.background",
        "--hidden-import=starlette.concurrency",
        "--hidden-import=starlette.config",
        "--hidden-import=starlette.convertors",
        "--hidden-import=starlette.datastructures",
        "--hidden-import=starlette.endpoints",
        "--hidden-import=starlette.exceptions",
        "--hidden-import=starlette.formparsers",
        "--hidden-import=starlette.middleware.authentication",
        "--hidden-import=starlette.middleware.base",
        "--hidden-import=starlette.middleware.cors",
        "--hidden-import=starlette.middleware.errors",
        "--hidden-import=starlette.middleware.gzip",
        "--hidden-import=starlette.middleware.httpsredirect",
        "--hidden-import=starlette.middleware.sessions",
        "--hidden-import=starlette.middleware.trustedhost",
        "--hidden-import=starlette.middleware.wsgi",
        "--hidden-import=starlette.schemas",
        "--hidden-import=starlette.status",
        "--hidden-import=starlette.testclient",
        "--hidden-import=starlette.types",
        "--hidden-import=sse_starlette",
        "--hidden-import=sse_starlette.sse",
        # SSL certificates (needed for HTTPS connections)
        "--collect-data=certifi",
        # Exclude packages not needed in local mode
        "--exclude-module=uvicorn",
        "--exclude-module=fastapi",
        "--exclude-module=docker",
        "--exclude-module=kubernetes",
        "--exclude-module=torch",
        "--exclude-module=tensorflow",
        "--exclude-module=numpy",
        "--exclude-module=pandas",
        "--exclude-module=scipy",
        "--exclude-module=matplotlib",
        "--exclude-module=PIL",
        "--exclude-module=cv2",
        # Entry point
        str(executor_root / "main.py"),
    ]

    print("Building executable...")
    print(f"Command: {' '.join(cmd[:10])}...")  # Print first few args

    result = subprocess.run(cmd, capture_output=False)

    if result.returncode != 0:
        print(f"Build failed with return code {result.returncode}")
        sys.exit(1)

    # Check output
    output_path = executor_root / "dist" / output_name
    if output_path.exists():
        size_mb = output_path.stat().st_size / (1024 * 1024)
        print(f"\nBuild successful!")
        print(f"Output: {output_path}")
        print(f"Size: {size_mb:.1f} MB")
    else:
        print(f"Error: Output file not found at {output_path}")
        sys.exit(1)


def main():
    """Main entry point."""
    print("=" * 60)
    print("Wegent Local Executor - Build Script")
    print("=" * 60)
    print(f"Platform: {platform.system()} {platform.machine()}")
    print(f"Python: {sys.version}")
    print()

    # Clean previous builds
    clean_build_artifacts()

    # Build executable
    build_executable()

    print()
    print("=" * 60)
    print("Build complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
