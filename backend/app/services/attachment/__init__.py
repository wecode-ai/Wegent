# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment service module for file upload, document parsing, and storage.

This module provides:
- AttachmentService: Main service for attachment lifecycle management
- DocumentParser: Document parsing and text extraction
- StorageBackend: Abstract interface for storage backends
- MySQLStorageBackend: Default MySQL-based storage implementation
- Storage factory functions for backend instantiation
"""

from app.services.attachment.attachment_service import (
    AttachmentService,
    attachment_service,
)
from app.services.attachment.mysql_storage import MySQLStorageBackend
from app.services.attachment.parser import DocumentParser
from app.services.attachment.storage_backend import StorageBackend, StorageError
from app.services.attachment.storage_factory import (
    clear_storage_backend_cache,
    get_storage_backend,
    get_storage_backend_name,
    register_storage_backend,
)

__all__ = [
    # Main service
    "AttachmentService",
    "attachment_service",
    # Document parser
    "DocumentParser",
    # Storage backend interface and implementations
    "StorageBackend",
    "StorageError",
    "MySQLStorageBackend",
    # Factory functions
    "get_storage_backend",
    "get_storage_backend_name",
    "register_storage_backend",
    "clear_storage_backend_cache",
]
