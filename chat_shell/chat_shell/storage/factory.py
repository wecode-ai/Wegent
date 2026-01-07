"""
Storage factory for chat_shell.

Provides factory functions to create storage providers.
"""

from enum import Enum
from typing import Optional

from chat_shell.storage.interfaces import StorageProvider


class StorageType(str, Enum):
    """Storage type enumeration."""

    MEMORY = "memory"
    SQLITE = "sqlite"
    REMOTE = "remote"


def create_storage_provider(
    storage_type: StorageType | str,
    **kwargs,
) -> StorageProvider:
    """
    Create a storage provider.

    Args:
        storage_type: Type of storage (memory, sqlite, remote)
        **kwargs: Additional arguments for the storage provider
            - For SQLITE:
                - db_path: Path to SQLite database (default: ~/.chat_shell/history.db)
            - For REMOTE:
                - base_url: Backend internal API address (required)
                - auth_token: Internal Service Token (optional, internal API doesn't require auth)
                - timeout: Request timeout in seconds (default: 30.0)

    Returns:
        StorageProvider instance

    Raises:
        ValueError: If storage_type is unknown or required arguments are missing
    """
    # Normalize storage type
    if isinstance(storage_type, str):
        try:
            storage_type = StorageType(storage_type.lower())
        except ValueError:
            raise ValueError(
                f"Unknown storage type: {storage_type}. "
                f"Available types: {', '.join(t.value for t in StorageType)}"
            )

    if storage_type == StorageType.MEMORY:
        from chat_shell.storage.memory import MemoryStorageProvider

        return MemoryStorageProvider()

    elif storage_type == StorageType.SQLITE:
        from chat_shell.storage.sqlite import SQLiteStorageProvider

        db_path = kwargs.get("db_path", "~/.chat_shell/history.db")
        return SQLiteStorageProvider(db_path)

    elif storage_type == StorageType.REMOTE:
        from chat_shell.storage.remote import RemoteStorageProvider

        base_url = kwargs.get("base_url")
        auth_token = kwargs.get("auth_token", "")  # Optional for internal API
        timeout = kwargs.get("timeout", 30.0)

        if not base_url:
            raise ValueError("base_url is required for remote storage")

        return RemoteStorageProvider(base_url, auth_token, timeout)

    else:
        raise ValueError(f"Unknown storage type: {storage_type}")


async def create_and_initialize_storage(
    storage_type: StorageType | str,
    **kwargs,
) -> StorageProvider:
    """
    Create and initialize a storage provider.

    This is a convenience function that creates and initializes the storage
    in one call.

    Args:
        storage_type: Type of storage
        **kwargs: Additional arguments for the storage provider

    Returns:
        Initialized StorageProvider instance
    """
    provider = create_storage_provider(storage_type, **kwargs)
    await provider.initialize()
    return provider
