# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend factory for creating storage backend instances.

This module provides a registry-based factory for storage backends,
allowing external plugins to register custom storage implementations
without modifying the core codebase.

Usage:
    # Register a custom backend (e.g., in your plugin's __init__.py)
    from app.services.attachment import register_storage_backend

    def my_s3_factory(db):
        return MyS3StorageBackend(db)

    register_storage_backend("s3", my_s3_factory)
    register_storage_backend("minio", my_s3_factory)  # Can reuse same factory

    # The backend will be automatically used when configured:
    # ATTACHMENT_STORAGE_BACKEND=s3
"""

import logging
from typing import TYPE_CHECKING, Callable, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.attachment.storage_backend import StorageBackend

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# Type alias for storage backend factory function
StorageBackendFactory = Callable[[Session], StorageBackend]


class StorageBackendRegistry:
    """
    Registry for storage backend factories.

    This singleton class manages the registration and retrieval of
    storage backend factories. It allows external plugins to register
    custom storage backends without modifying the core codebase.

    Example:
        # Register a custom backend
        registry = StorageBackendRegistry()
        registry.register("s3", lambda db: S3StorageBackend(db))

        # Get a backend instance
        backend = registry.get("s3", db_session)
    """

    _instance: Optional["StorageBackendRegistry"] = None
    _initialized: bool = False

    def __new__(cls) -> "StorageBackendRegistry":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        # Only initialize once (singleton pattern)
        if StorageBackendRegistry._initialized:
            return
        StorageBackendRegistry._initialized = True
        self._backends: Dict[str, StorageBackendFactory] = {}
        self._default_backend: str = "mysql"
        self._register_default_backends()

    def _register_default_backends(self) -> None:
        """Register the default MySQL backend."""
        # Import here to avoid circular imports
        from app.services.attachment.mysql_storage import MySQLStorageBackend

        self.register("mysql", lambda db: MySQLStorageBackend(db))

    def register(
        self,
        backend_type: str,
        factory: StorageBackendFactory,
        override: bool = False,
    ) -> None:
        """
        Register a storage backend factory.

        Args:
            backend_type: The backend type identifier (e.g., "s3", "minio")
            factory: A callable that takes a db session and returns a StorageBackend
            override: If True, allow overriding existing registrations

        Raises:
            ValueError: If backend_type is already registered and override is False
        """
        backend_type = backend_type.lower()

        if backend_type in self._backends and not override:
            raise ValueError(
                f"Storage backend '{backend_type}' is already registered. "
                f"Use override=True to replace it."
            )

        self._backends[backend_type] = factory
        logger.info(f"Registered storage backend: {backend_type}")

    def unregister(self, backend_type: str) -> bool:
        """
        Unregister a storage backend factory.

        Args:
            backend_type: The backend type identifier to unregister

        Returns:
            True if the backend was unregistered, False if it wasn't registered
        """
        backend_type = backend_type.lower()

        if backend_type == self._default_backend:
            logger.warning(
                f"Cannot unregister the default backend '{self._default_backend}'"
            )
            return False

        if backend_type in self._backends:
            del self._backends[backend_type]
            logger.info(f"Unregistered storage backend: {backend_type}")
            return True

        return False

    def get(self, backend_type: str, db: Session) -> StorageBackend:
        """
        Get a storage backend instance.

        Args:
            backend_type: The backend type identifier
            db: SQLAlchemy database session

        Returns:
            StorageBackend instance

        Raises:
            ValueError: If backend_type is not registered
        """
        backend_type = backend_type.lower()

        if backend_type not in self._backends:
            raise ValueError(
                f"Storage backend '{backend_type}' is not registered. "
                f"Available backends: {', '.join(self.list_backends())}"
            )

        factory = self._backends[backend_type]
        return factory(db)

    def get_or_default(self, backend_type: str, db: Session) -> StorageBackend:
        """
        Get a storage backend instance, falling back to default if not registered.

        Args:
            backend_type: The backend type identifier
            db: SQLAlchemy database session

        Returns:
            StorageBackend instance (requested or default)
        """
        backend_type = backend_type.lower()

        if backend_type not in self._backends:
            logger.warning(
                f"Storage backend '{backend_type}' is not registered. "
                f"Falling back to default backend '{self._default_backend}'."
            )
            backend_type = self._default_backend

        return self.get(backend_type, db)

    def is_registered(self, backend_type: str) -> bool:
        """
        Check if a backend type is registered.

        Args:
            backend_type: The backend type identifier

        Returns:
            True if registered, False otherwise
        """
        return backend_type.lower() in self._backends

    def list_backends(self) -> List[str]:
        """
        List all registered backend types.

        Returns:
            List of registered backend type identifiers
        """
        return list(self._backends.keys())

    def set_default(self, backend_type: str) -> None:
        """
        Set the default backend type.

        Args:
            backend_type: The backend type to use as default

        Raises:
            ValueError: If backend_type is not registered
        """
        backend_type = backend_type.lower()

        if backend_type not in self._backends:
            raise ValueError(
                f"Cannot set default to unregistered backend '{backend_type}'"
            )

        self._default_backend = backend_type
        logger.info(f"Set default storage backend to: {backend_type}")

    @property
    def default_backend(self) -> str:
        """Get the default backend type."""
        return self._default_backend


# Global registry instance
_registry = StorageBackendRegistry()


def register_storage_backend(
    backend_type: str,
    factory: StorageBackendFactory,
    override: bool = False,
) -> None:
    """
    Register a storage backend factory.

    This is the main entry point for external plugins to register
    custom storage backends.

    Args:
        backend_type: The backend type identifier (e.g., "s3", "minio")
        factory: A callable that takes a db session and returns a StorageBackend
        override: If True, allow overriding existing registrations

    Example:
        from app.services.attachment import register_storage_backend

        def create_s3_backend(db):
            return S3StorageBackend(
                db=db,
                endpoint=os.getenv("S3_ENDPOINT"),
                access_key=os.getenv("S3_ACCESS_KEY"),
                secret_key=os.getenv("S3_SECRET_KEY"),
            )

        register_storage_backend("s3", create_s3_backend)
    """
    _registry.register(backend_type, factory, override)


def unregister_storage_backend(backend_type: str) -> bool:
    """
    Unregister a storage backend factory.

    Args:
        backend_type: The backend type identifier to unregister

    Returns:
        True if the backend was unregistered, False if it wasn't registered
    """
    return _registry.unregister(backend_type)


def list_storage_backends() -> List[str]:
    """
    List all registered storage backend types.

    Returns:
        List of registered backend type identifiers
    """
    return _registry.list_backends()


def is_storage_backend_registered(backend_type: str) -> bool:
    """
    Check if a storage backend type is registered.

    Args:
        backend_type: The backend type identifier

    Returns:
        True if registered, False otherwise
    """
    return _registry.is_registered(backend_type)


def get_storage_backend(db: Session) -> StorageBackend:
    """
    Get the configured storage backend instance.

    Creates and returns the appropriate storage backend based on
    the ATTACHMENT_STORAGE_BACKEND configuration setting.

    If the configured backend is not registered, falls back to
    the default backend (mysql) with a warning.

    Args:
        db: SQLAlchemy database session

    Returns:
        StorageBackend instance
    """
    backend_type = settings.ATTACHMENT_STORAGE_BACKEND.lower()
    logger.debug(f"Getting storage backend: {backend_type}")
    return _registry.get_or_default(backend_type, db)


def is_external_storage_configured() -> bool:
    """
    Check if an external storage backend is configured.

    Returns:
        True if a non-default storage backend is configured and registered,
        False otherwise
    """
    backend_type = settings.ATTACHMENT_STORAGE_BACKEND.lower()
    return backend_type != _registry.default_backend and _registry.is_registered(
        backend_type
    )
