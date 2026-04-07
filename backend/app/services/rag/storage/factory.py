# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage backend factory for backend control-plane resolution."""

from typing import Dict, List, Optional

from app.schemas.kind import Retriever
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.factory import (
    STORAGE_BACKEND_REGISTRY as ENGINE_STORAGE_BACKEND_REGISTRY,
)
from knowledge_engine.storage.factory import (
    create_storage_backend_from_config as engine_create_storage_backend_from_config,
)
from knowledge_engine.storage.factory import (
    create_storage_backend_from_runtime_config as engine_create_storage_backend_from_runtime_config,
)
from knowledge_engine.storage.factory import (
    get_supported_storage_types as engine_get_supported_storage_types,
)
from shared.models import RuntimeRetrieverConfig

STORAGE_BACKEND_REGISTRY = ENGINE_STORAGE_BACKEND_REGISTRY


def get_supported_storage_types() -> List[str]:
    """
    Get list of supported storage types.

    Returns:
        List of storage type names
    """
    return engine_get_supported_storage_types()


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

    return engine_create_storage_backend_from_config(
        storage_type=storage_type,
        url=url,
        username=username,
        password=password,
        api_key=api_key,
        index_strategy=index_strategy,
        ext=ext,
    )


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

    return engine_create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name=retriever.metadata.name,
            namespace=retriever.metadata.namespace,
            storage_config={
                "type": storage_type,
                "url": storage_config.url,
                "username": storage_config.username,
                "password": storage_config.password,
                "apiKey": storage_config.apiKey,
                "indexStrategy": storage_config.indexStrategy.model_dump(
                    exclude_none=True
                ),
                "ext": storage_config.ext or {},
            },
        )
    )


def create_storage_backend_from_runtime_config(
    retriever_config: RuntimeRetrieverConfig,
) -> BaseStorageBackend:
    """Create storage backend from resolved runtime retriever config."""
    return engine_create_storage_backend_from_runtime_config(retriever_config)
