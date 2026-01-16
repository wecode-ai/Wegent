# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DataTable Service for backend.

This module provides the full table service implementation including:
- Abstract base classes for table providers
- Provider registry for managing different table providers (dingtalk, feishu, etc.)
- Unified service interface for querying table data
- Data models for requests and responses
"""

from .base import BaseTableProvider, TableProviderRegistry
from .models import (
    TableContext,
    TableQueryRequest,
    TableQueryResponse,
    TableValidateRequest,
    TableValidateResponse,
)
from .service import DataTableService
from .url_parser import TableURLParser

__all__ = [
    "BaseTableProvider",
    "TableProviderRegistry",
    "TableContext",
    "TableQueryRequest",
    "TableQueryResponse",
    "TableValidateRequest",
    "TableValidateResponse",
    "DataTableService",
    "TableURLParser",
]
