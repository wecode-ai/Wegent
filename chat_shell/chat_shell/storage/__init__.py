"""
Storage module for chat_shell.

Provides abstract storage interfaces and implementations for:
- Chat history storage
- Tool result caching
"""

from chat_shell.storage.factory import StorageType, create_storage_provider
from chat_shell.storage.interfaces import (
    HistoryStoreInterface,
    Message,
    StorageProvider,
    ToolResultStoreInterface,
)

__all__ = [
    # Interfaces
    "HistoryStoreInterface",
    "ToolResultStoreInterface",
    "StorageProvider",
    "Message",
    # Factory
    "StorageType",
    "create_storage_provider",
]
