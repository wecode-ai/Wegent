# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend factory for creating storage backends from Retriever CRD.
"""

from typing import Any, Dict

from app.schemas.kind import Retriever
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.elasticsearch_backend import ElasticsearchBackend
from app.services.rag.storage.qdrant_backend import QdrantBackend


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

    # Build config dict for backend
    config = {
        "url": storage_config.url,
        "username": storage_config.username,
        "password": storage_config.password,
        "apiKey": storage_config.apiKey,
        "indexStrategy": storage_config.indexStrategy.model_dump(exclude_none=True),
        "ext": storage_config.ext or {},
    }

    # Create backend based on type
    if storage_type == "elasticsearch":
        return ElasticsearchBackend(config)
    elif storage_type == "qdrant":
        return QdrantBackend(config)
    else:
        raise ValueError(f"Unsupported storage type: {storage_type}")
