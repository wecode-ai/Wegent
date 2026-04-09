# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage backend factory for resolved runtime config."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Type

from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.qdrant_backend import QdrantBackend
from shared.models import RuntimeRetrieverConfig

STORAGE_BACKEND_REGISTRY: Dict[str, Type[BaseStorageBackend]] = {
    "elasticsearch": ElasticsearchBackend,
    "qdrant": QdrantBackend,
    "milvus": MilvusBackend,
}


def get_supported_storage_types() -> List[str]:
    return list(STORAGE_BACKEND_REGISTRY.keys())


def get_supported_retrieval_methods(storage_type: str) -> List[str]:
    normalized_type = storage_type.lower()
    if normalized_type not in STORAGE_BACKEND_REGISTRY:
        raise ValueError(
            f"Unsupported storage type: {normalized_type}. "
            f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
        )

    backend_class = STORAGE_BACKEND_REGISTRY[normalized_type]
    return backend_class.get_supported_retrieval_methods()


def get_all_storage_retrieval_methods() -> Dict[str, List[str]]:
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
    index_strategy: Optional[Dict[str, Any]] = None,
    ext: Optional[Dict[str, Any]] = None,
) -> BaseStorageBackend:
    normalized_type = storage_type.lower()
    if normalized_type not in STORAGE_BACKEND_REGISTRY:
        raise ValueError(
            f"Unsupported storage type: {normalized_type}. "
            f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
        )
    if not url:
        raise ValueError(f"storage url must be provided for {normalized_type} backend")

    config = {
        "url": url,
        "username": username,
        "password": password,
        "apiKey": api_key,
        "indexStrategy": index_strategy or {"mode": "per_dataset"},
        "ext": ext or {},
    }
    backend_class = STORAGE_BACKEND_REGISTRY[normalized_type]
    return backend_class(config)


def create_storage_backend_from_runtime_config(
    retriever_config: RuntimeRetrieverConfig,
) -> BaseStorageBackend:
    storage_config = retriever_config.storage_config or {}
    storage_type = (storage_config.get("type") or "").lower()
    if storage_type not in STORAGE_BACKEND_REGISTRY:
        raise ValueError(
            f"Unsupported storage type: {storage_type or '<missing>'}. "
            f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
        )
    if not storage_config.get("url"):
        raise ValueError(
            f"storage url must be provided for {storage_type or '<missing>'} backend"
        )

    config = {
        "url": storage_config.get("url"),
        "username": storage_config.get("username"),
        "password": storage_config.get("password"),
        "apiKey": storage_config.get("apiKey"),
        "indexStrategy": storage_config.get("indexStrategy") or {"mode": "per_dataset"},
        "ext": storage_config.get("ext") or {},
    }
    backend_class = STORAGE_BACKEND_REGISTRY[storage_type]
    return backend_class(config)
