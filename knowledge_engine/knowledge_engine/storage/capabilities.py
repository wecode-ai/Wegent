# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage capability registry that never loads backend implementations.

The registry carries the storage types, their retrieval methods and the import
path of each backend class. Callers that only need the capability list never
load llama-index, pymilvus, qdrant or elasticsearch.
"""

from __future__ import annotations

from typing import Dict, List, NamedTuple, Tuple


class StorageBackendSpec(NamedTuple):
    """Import path and retrieval methods of one storage backend."""

    module: str
    class_name: str
    retrieval_methods: Tuple[str, ...]


# Backend classes declare their ``SUPPORTED_RETRIEVAL_METHODS`` from here, so
# this registry stays the single source of truth.
STORAGE_BACKEND_SPECS: Dict[str, StorageBackendSpec] = {
    "elasticsearch": StorageBackendSpec(
        module="knowledge_engine.storage.elasticsearch_backend",
        class_name="ElasticsearchBackend",
        retrieval_methods=("vector", "keyword", "hybrid"),
    ),
    "qdrant": StorageBackendSpec(
        module="knowledge_engine.storage.qdrant_backend",
        class_name="QdrantBackend",
        retrieval_methods=("vector",),
    ),
    "milvus": StorageBackendSpec(
        module="knowledge_engine.storage.milvus_backend",
        class_name="MilvusBackend",
        retrieval_methods=("vector", "keyword", "hybrid"),
    ),
}


def normalize_storage_type(storage_type: str) -> str:
    """Return the canonical storage type, or raise when it is unknown."""
    normalized_type = (storage_type or "").lower()
    if normalized_type not in STORAGE_BACKEND_SPECS:
        raise ValueError(
            f"Unsupported storage type: {normalized_type or '<missing>'}. "
            f"Supported types: {get_supported_storage_types()}"
        )
    return normalized_type


def get_supported_storage_types() -> List[str]:
    """Return every storage type the kernel can build a backend for."""
    return list(STORAGE_BACKEND_SPECS.keys())


def get_supported_retrieval_methods(storage_type: str) -> List[str]:
    """Return the retrieval methods one storage type supports."""
    spec = STORAGE_BACKEND_SPECS[normalize_storage_type(storage_type)]
    return list(spec.retrieval_methods)


def get_all_storage_retrieval_methods() -> Dict[str, List[str]]:
    """Return the retrieval methods of every supported storage type."""
    return {
        storage_type: list(spec.retrieval_methods)
        for storage_type, spec in STORAGE_BACKEND_SPECS.items()
    }
