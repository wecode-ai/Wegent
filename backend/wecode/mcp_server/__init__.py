# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal adapters for the external knowledge MCP server.

Imported as a side effect during app startup via ``wecode/api/__init__.py``.
"""

from wecode.mcp_server.installer import install

install()
