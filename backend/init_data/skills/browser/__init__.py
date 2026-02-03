# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser automation skill package using Playwright.

Architecture:
- tools/ - Python tool definitions (sent to LLM)
- scripts/ - JS scripts executed in sandbox (Playwright Node.js API)

All browser operations are executed in isolated sandbox containers.
"""

__all__ = [
    "tools",
    "scripts",
    "provider",
]
