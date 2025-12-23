# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend factory for creating storage backends from Retriever CRD.
"""

from typing import Dict, List, Optional, Type

from app.schemas.kind import Retriever
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.elasticsearch_backend import ElasticsearchBackend
from app.services.rag.storage.qdrant_backend import QdrantBackend

# Registry of storage backend classes by type
STORAGE_BACKEND_REGISTRY: Dict[str, Type[BaseStorageBackend]] = {
    "elasticsearch": ElasticsearchBackend,
    "qdrant": QdrantBackend,
}


def get_supported_storage_types() -> List[str]:
    """
    Get list of supported storage types.

    Returns:
        List of storage type names
    """
    return list(STORAGE_BACKEND_REGISTRY.keys())


def get_supported_retrieval_methods(storage_type: str) -> List[str]:
    """
    Get supported retrieval methods for a storage type.

    Args:
        storage_type: Storage type name (e.g., 'elasticsearch', 'qdrant')

    Returns:
        List of supported retrieval method names

    Raises:
        ValueError: If storage type is not supported
    """
    storage_type = storage_type.lower()
    if storage_type not in STORAGE_BACKEND_REGISTRY:
        raise ValueError(
            f"Unsupported storage type: {storage_type}. "
            f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
        )

    backend_class = STORAGE_BACKEND_REGISTRY[storage_type]
    return backend_class.get_supported_retrieval_methods()


def get_all_storage_retrieval_methods() -> Dict[str, List[str]]:
    """
    Get supported retrieval methods for all storage types.

    Returns:
        Dict mapping storage type to list of supported retrieval methods
        Example: {
            'elasticsearch': ['vector', 'keyword', 'hybrid'],
            'qdrant': ['vector']
        }
    """
    return {
        storage_type: backend_class.get_supported_retrieval_methods()
        for storage_type, backend_class in STORAGE_BACKEND_REGISTRY.items()
    }


def create_storage_backend_from_config(
    storage_type: str,
    url: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    api_key: Optional[str] = None,
    index_strategy: Optional[Dict] = None,
    ext: Optional[Dict] = None,
) -> BaseStorageBackend:
    """
    Create storage backend from configuration parameters.

    This is useful for testing connections before creating a Retriever CRD.

    Args:
        storage_type: Storage type name (e.g., 'elasticsearch', 'qdrant')
        url: Storage server URL
        username: Optional username for authentication
        password: Optional password for authentication
        api_key: Optional API key for authentication
        index_strategy: Optional index strategy config
        ext: Optional additional config

    Returns:
        Storage backend instance

    Raises:
        ValueError: If storage type is not supported
    """
    storage_type = storage_type.lower()

    if storage_type not in STORAGE_BACKEND_REGISTRY:
        raise ValueError(
            f"Unsupported storage type: {storage_type}. "
            f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
        )

    # Build config dict for backend
    config = {
        "url": url,
        "username": username,
        "password": password,
        "apiKey": api_key,
        "indexStrategy": index_strategy or {"mode": "per_dataset"},
        "ext": ext or {},
    }

    # Create backend instance
    backend_class = STORAGE_BACKEND_REGISTRY[storage_type]
    return backend_class(config)


def create_storage_backend(retriever: Retriever) -> BaseStorageBackend:
    """
    Create storage backend from Retriever CRD.

    Args:
        retriever: Retriever CRD instance

    Returns:
        Storage backend instance

    Raises:
        ValueError: If storage type is not supported
    """
    storage_config = retriever.spec.storageConfig
    storage_type = storage_config.type.lower()

    if storage_type not in STORAGE_BACKEND_REGISTRY:
        raise ValueError(
            f"Unsupported storage type: {storage_type}. "
            f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
        )

    # Build config dict for backend
    config = {
        "url": storage_config.url,
        "username": storage_config.username,
        "password": storage_config.password,
        "apiKey": storage_config.apiKey,
        "indexStrategy": storage_config.indexStrategy.model_dump(exclude_none=True),
        "ext": storage_config.ext or {},
    }

    # Create backend instance
    backend_class = STORAGE_BACKEND_REGISTRY[storage_type]
    return backend_class(config)
