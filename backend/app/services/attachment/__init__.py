# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment service module for file upload and document parsing.

This module provides:
- StorageBackend: Abstract interface for pluggable storage backends
- MySQLStorageBackend: Default MySQL-based storage implementation
- AttachmentService: High-level service for attachment management
- DocumentParser: Document parsing utilities
"""

from app.services.attachment.attachment_service import attachment_service
from app.services.attachment.mysql_storage import MySQLStorageBackend
from app.services.attachment.parser import DocumentParser
from app.services.attachment.storage_backend import (
    StorageBackend,
    StorageError,
    generate_storage_key,
)
from app.services.attachment.storage_factory import (
    get_storage_backend,
    is_external_storage_configured,
)

__all__ = [
    "StorageBackend",
    "StorageError",
    "MySQLStorageBackend",
    "DocumentParser",
    "attachment_service",
    "get_storage_backend",
    "is_external_storage_configured",
    "generate_storage_key",
]
