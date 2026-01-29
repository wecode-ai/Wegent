# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP Server tools module.

Contains tools for:
- System MCP (silent_exit)
- Knowledge MCP (list_knowledge_bases, list_documents, create_document, update_document)
"""

from .knowledge import (
    create_document,
    list_documents,
    list_knowledge_bases,
    update_document,
)
from .silent_exit import silent_exit

__all__ = [
    "silent_exit",
    "list_knowledge_bases",
    "list_documents",
    "create_document",
    "update_document",
]
