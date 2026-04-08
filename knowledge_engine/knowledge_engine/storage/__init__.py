# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage interfaces for knowledge_engine."""

from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
from knowledge_engine.storage.factory import (
    create_storage_backend_from_config,
    create_storage_backend_from_runtime_config,
    get_supported_storage_types,
)
from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.qdrant_backend import QdrantBackend

__all__ = [
    "BaseStorageBackend",
    "ChunkMetadata",
    "ElasticsearchBackend",
    "MilvusBackend",
    "QdrantBackend",
    "create_storage_backend_from_config",
    "create_storage_backend_from_runtime_config",
    "get_supported_storage_types",
]
