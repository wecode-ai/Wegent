# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight table services for backend.

This module provides URL parsing functionality for table contexts.
The full table service implementation is in chat_shell.

For table data querying, use chat_shell service via HTTP API.
"""

from .url_parser import TableContext, TableURLParser

# Backward compatibility aliases
TableProviderRegistry = TableURLParser

__all__ = [
    "TableContext",
    "TableURLParser",
    "TableProviderRegistry",  # Backward compatibility
]
