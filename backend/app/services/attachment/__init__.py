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
- Registry-based storage backend factory for extensibility

Storage Backend Registration:
    External plugins can register custom storage backends without modifying
    the core codebase. Example:

    ```python
    from app.services.attachment import register_storage_backend, StorageBackend

    class MyS3StorageBackend(StorageBackend):
        # ... implementation ...
        pass

    def create_s3_backend(db):
        return MyS3StorageBackend(db)

    # Register the backend
    register_storage_backend("s3", create_s3_backend)

    # Now set ATTACHMENT_STORAGE_BACKEND=s3 in your config
    ```
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
    StorageBackendRegistry,
    get_storage_backend,
    is_external_storage_configured,
    is_storage_backend_registered,
    list_storage_backends,
    register_storage_backend,
    unregister_storage_backend,
)

__all__ = [
    # Core classes
    "StorageBackend",
    "StorageError",
    "MySQLStorageBackend",
    "DocumentParser",
    # Services
    "attachment_service",
    # Factory functions
    "get_storage_backend",
    "is_external_storage_configured",
    "generate_storage_key",
    # Registry functions (for external plugins)
    "StorageBackendRegistry",
    "register_storage_backend",
    "unregister_storage_backend",
    "list_storage_backends",
    "is_storage_backend_registered",
]
