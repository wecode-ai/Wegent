# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Table services for querying data from external table sources.

This module provides a unified interface for querying data from external
table sources (DingTalk Notable, Feishu Bitable, etc.).
"""

from .base import BaseTableProvider, TableContext, TableProviderRegistry

# Import providers to register them
from .dingtalk import DingTalkProvider  # noqa: F401
from .service import DataTableService

__all__ = [
    "BaseTableProvider",
    "TableContext",
    "TableProviderRegistry",
    "DataTableService",
    "DingTalkProvider",
]
