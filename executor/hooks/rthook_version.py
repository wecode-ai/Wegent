# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
PyInstaller runtime hook for handling --version flag.

This hook runs before the main script and handles the --version/-v flag
immediately to avoid any module initialization that could cause cleanup errors.

The version is read from the embedded _EMBEDDED_VERSION in version.py,
which is set during the build process.
"""

import sys

# Check for version flag before any other initialization
if "--version" in sys.argv or "-v" in sys.argv:
    # Read version directly from the embedded value
    # This avoids importing any modules that could cause cleanup issues
    try:
        # Try to import just the version module with minimal dependencies
        from executor.version import _EMBEDDED_VERSION

        version = _EMBEDDED_VERSION if _EMBEDDED_VERSION else "unknown"
    except ImportError:
        version = "unknown"

    # Write to stdout and flush
    sys.stdout.write(version + "\n")
    sys.stdout.flush()

    # Use os._exit to avoid any cleanup hooks
    import os

    os._exit(0)
