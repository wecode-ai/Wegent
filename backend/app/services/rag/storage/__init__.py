# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend abstraction for RAG functionality.
"""

from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.elasticsearch_backend import ElasticsearchBackend
from app.services.rag.storage.factory import create_storage_backend
from app.services.rag.storage.qdrant_backend import QdrantBackend

__all__ = [
    "BaseStorageBackend",
    "ElasticsearchBackend",
    "QdrantBackend",
    "create_storage_backend",
]
