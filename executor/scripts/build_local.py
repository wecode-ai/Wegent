#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
PyInstaller build script for local mode executor.

This script builds the executor as a standalone binary for local deployment.
Supports macOS (Universal Binary for Intel and Apple Silicon).

Usage:
    cd executor
    uv run python scripts/build_local.py

Output:
    dist/wegent-executor (or wegent-executor.exe on Windows)
"""

import os
import sys
from pathlib import Path


def get_project_root() -> Path:
    """Get the project root directory (parent of executor/)."""
    return Path(__file__).parent.parent.parent


def build():
    """Build the local executor binary."""
    try:
        import PyInstaller.__main__
    except ImportError:
        print("Error: PyInstaller not installed. Install with:")
        print("  uv add pyinstaller --group build")
        sys.exit(1)

    project_root = get_project_root()
    executor_dir = project_root / "executor"
    shared_dir = project_root / "shared"

    # Verify directories exist
    if not executor_dir.exists():
        print(f"Error: executor directory not found at {executor_dir}")
        sys.exit(1)

    if not shared_dir.exists():
        print(f"Error: shared directory not found at {shared_dir}")
        sys.exit(1)

    # Change to project root for proper path resolution
    original_cwd = os.getcwd()
    os.chdir(project_root)

    try:
        # Build arguments
        args = [
            str(executor_dir / "main.py"),
            "--name=wegent-executor",
            "--onefile",
            "--console",
            # Add data directories
            f"--add-data={executor_dir}{os.pathsep}executor",
            f"--add-data={shared_dir}{os.pathsep}shared",
            # Hidden imports for dynamic modules
            "--hidden-import=executor.modes.local",
            "--hidden-import=executor.modes.local.runner",
            "--hidden-import=executor.modes.local.websocket_client",
            "--hidden-import=executor.modes.local.heartbeat",
            "--hidden-import=executor.modes.local.progress_reporter",
            "--hidden-import=executor.modes.local.handlers",
            "--hidden-import=executor.modes.local.events",
            "--hidden-import=executor.agents.claude_code.claude_code_agent",
            "--hidden-import=socketio",
            "--hidden-import=engineio",
            "--hidden-import=aiohttp",
            # Exclude modules not needed for local mode
            "--exclude-module=docker",
            "--exclude-module=kubernetes",
            "--exclude-module=uvicorn",
            "--exclude-module=fastapi",
            "--exclude-module=starlette",
            # Output directory
            f"--distpath={executor_dir / 'dist'}",
            f"--workpath={executor_dir / 'pyinstaller_build'}",
            f"--specpath={executor_dir / 'scripts'}",
        ]

        # Platform-specific options
        if sys.platform == "darwin":
            # macOS: Build Universal Binary for both Intel and Apple Silicon
            args.append("--target-arch=universal2")

        print("Building wegent-executor binary...")
        print(f"  Platform: {sys.platform}")
        print(f"  Python: {sys.version}")
        print(f"  Output: {executor_dir / 'dist' / 'wegent-executor'}")

        PyInstaller.__main__.run(args)

        print("\nBuild completed successfully!")
        print(f"Binary location: {executor_dir / 'dist' / 'wegent-executor'}")

    finally:
        os.chdir(original_cwd)


if __name__ == "__main__":
    build()
