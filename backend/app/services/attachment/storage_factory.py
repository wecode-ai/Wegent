# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend factory for attachment storage.

This module provides a factory function to create storage backend instances
based on configuration. It supports extensibility through a registry mechanism.

To add a custom storage backend:
1. Create a class implementing the StorageBackend interface
2. Register it using register_storage_backend() or
3. Configure ATTACHMENT_STORAGE_BACKEND with a fully qualified class name

Example custom backend registration:
    from app.services.attachment.storage_factory import register_storage_backend
    from my_package.s3_storage import S3StorageBackend

    register_storage_backend("s3", S3StorageBackend)
"""

import importlib
import logging
from typing import Callable, Dict, Optional, Type

from app.core.config import settings
from app.services.attachment.mysql_storage import MySQLStorageBackend
from app.services.attachment.storage_backend import StorageBackend

logger = logging.getLogger(__name__)

# Registry for storage backend classes
_storage_backend_registry: Dict[str, Type[StorageBackend]] = {
    "": MySQLStorageBackend,  # Empty string defaults to MySQL
    "mysql": MySQLStorageBackend,
}

# Cached backend instance
_cached_backend: Optional[StorageBackend] = None


def register_storage_backend(name: str, backend_class: Type[StorageBackend]) -> None:
    """
    Register a custom storage backend.

    Args:
        name: Backend identifier (used in ATTACHMENT_STORAGE_BACKEND config)
        backend_class: Class implementing StorageBackend interface
    """
    if not issubclass(backend_class, StorageBackend):
        raise ValueError(f"{backend_class} must be a subclass of StorageBackend")

    _storage_backend_registry[name.lower()] = backend_class
    logger.info(f"Registered storage backend: {name}")


def _load_backend_class(class_path: str) -> Type[StorageBackend]:
    """
    Dynamically load a backend class from a fully qualified class path.

    Args:
        class_path: Fully qualified class path (e.g., 'my_package.s3_storage.S3StorageBackend')

    Returns:
        The loaded backend class

    Raises:
        ImportError: If the module or class cannot be found
        ValueError: If the class doesn't implement StorageBackend
    """
    try:
        module_path, class_name = class_path.rsplit(".", 1)
        module = importlib.import_module(module_path)
        backend_class = getattr(module, class_name)

        if not issubclass(backend_class, StorageBackend):
            raise ValueError(f"{class_path} must be a subclass of StorageBackend")

        return backend_class

    except (ValueError, AttributeError) as e:
        raise ImportError(f"Failed to load storage backend class '{class_path}': {e}")


def get_storage_backend(force_new: bool = False) -> StorageBackend:
    """
    Get the configured storage backend instance.

    This function reads the ATTACHMENT_STORAGE_BACKEND configuration and
    returns the appropriate storage backend instance. Results are cached
    for performance.

    Args:
        force_new: If True, create a new instance instead of using cached one

    Returns:
        StorageBackend instance

    Raises:
        ValueError: If the configured backend is not found or invalid
    """
    global _cached_backend

    if _cached_backend is not None and not force_new:
        return _cached_backend

    backend_type = getattr(settings, "ATTACHMENT_STORAGE_BACKEND", "").strip().lower()

    # Check registry first
    if backend_type in _storage_backend_registry:
        backend_class = _storage_backend_registry[backend_type]
        logger.info(f"Using registered storage backend: {backend_type or 'mysql (default)'}")
    elif "." in backend_type:
        # Try to load as a fully qualified class path
        try:
            backend_class = _load_backend_class(backend_type)
            logger.info(f"Using dynamically loaded storage backend: {backend_type}")
        except ImportError as e:
            logger.error(f"Failed to load storage backend: {e}")
            raise ValueError(f"Invalid storage backend configuration: {backend_type}")
    else:
        raise ValueError(
            f"Unknown storage backend: {backend_type}. "
            f"Available backends: {list(_storage_backend_registry.keys())}"
        )

    _cached_backend = backend_class()
    return _cached_backend


def get_storage_backend_name() -> str:
    """
    Get the name of the currently configured storage backend.

    Returns:
        Storage backend name (e.g., 'mysql', 's3')
    """
    backend_type = getattr(settings, "ATTACHMENT_STORAGE_BACKEND", "").strip().lower()
    return backend_type if backend_type else "mysql"


def clear_storage_backend_cache() -> None:
    """
    Clear the cached storage backend instance.

    Useful for testing or when configuration changes.
    """
    global _cached_backend
    _cached_backend = None
    logger.debug("Storage backend cache cleared")
