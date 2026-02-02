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

    # Cross-compile for Intel on Apple Silicon:
    uv run python scripts/build_local.py --target-arch x86_64

Output:
    dist/wegent-executor (macOS/Linux)
    dist/wegent-executor.exe (Windows)
"""

import argparse
import os
import platform
import re
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


def get_version_from_pyproject() -> str:
    """Read version from pyproject.toml.

    Returns:
        Version string (e.g., "1.0.0")
    """
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib  # type: ignore

    pyproject_path = get_executor_root() / "pyproject.toml"
    with open(pyproject_path, "rb") as f:
        data = tomllib.load(f)
    return data.get("project", {}).get("version", "unknown")


def embed_version_in_source(version: str) -> str | None:
    """Embed version into version.py for PyInstaller builds.

    Args:
        version: Version string to embed

    Returns:
        Original content of version.py for restoration, or None if failed
    """
    version_py = get_executor_root() / "version.py"

    # Read original content
    original_content = version_py.read_text()

    # Replace _EMBEDDED_VERSION = None with the actual version
    modified_content = re.sub(
        r"_EMBEDDED_VERSION:\s*Optional\[str\]\s*=\s*None",
        f'_EMBEDDED_VERSION: Optional[str] = "{version}"',
        original_content,
    )

    if modified_content == original_content:
        print("Warning: Could not find _EMBEDDED_VERSION placeholder in version.py")
        return None

    # Write modified content
    version_py.write_text(modified_content)
    print(f"Embedded version {version} into version.py")

    return original_content


def restore_version_source(original_content: str) -> None:
    """Restore version.py to its original content.

    Args:
        original_content: Original content to restore
    """
    version_py = get_executor_root() / "version.py"
    version_py.write_text(original_content)
    print("Restored version.py to original content")


def build_executable(target_arch: str | None = None):
    """Build the executable using PyInstaller.

    Args:
        target_arch: Target architecture for cross-compilation (e.g., 'x86_64', 'arm64').
                     If None, builds for the native architecture.
    """
    project_root = get_project_root()
    executor_root = get_executor_root()

    # Get version and embed it into source
    version = get_version_from_pyproject()
    print(f"Building version: {version}")
    original_version_content = embed_version_in_source(version)

    try:
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

        # Add target architecture for cross-compilation on macOS
        if target_arch and platform.system() == "Darwin":
            cmd.insert(-1, f"--target-arch={target_arch}")
            print(f"Cross-compiling for architecture: {target_arch}")

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
            print(f"Version: {version}")
            if target_arch:
                print(f"Target architecture: {target_arch}")
        else:
            print(f"Error: Output file not found at {output_path}")
            sys.exit(1)
    finally:
        # Always restore version.py to its original content
        if original_version_content:
            restore_version_source(original_version_content)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Build Wegent Local Executor binary")
    parser.add_argument(
        "--target-arch",
        choices=["x86_64", "arm64"],
        help="Target architecture for cross-compilation (macOS only). "
        "Use 'x86_64' to build for Intel Macs on Apple Silicon.",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("Wegent Local Executor - Build Script")
    print("=" * 60)
    print(f"Platform: {platform.system()} {platform.machine()}")
    print(f"Python: {sys.version}")
    if args.target_arch:
        print(f"Target architecture: {args.target_arch}")
    print()

    # Clean previous builds
    clean_build_artifacts()

    # Build executable
    build_executable(target_arch=args.target_arch)

    print()
    print("=" * 60)
    print("Build complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
