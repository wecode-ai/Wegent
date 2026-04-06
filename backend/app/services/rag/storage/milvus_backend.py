# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backward-compatible re-export of the engine Milvus backend."""

from knowledge_engine.storage.milvus_backend import (
    DEFAULT_EMBEDDING_DIM,
    DEFAULT_TOP_K,
    MAX_QUERY_LIMIT,
    LazyAsyncMilvusVectorStore,
    MilvusBackend,
    MilvusClient,
    StorageContext,
    VectorStoreIndex,
)

__all__ = [
    "DEFAULT_EMBEDDING_DIM",
    "DEFAULT_TOP_K",
    "MAX_QUERY_LIMIT",
    "LazyAsyncMilvusVectorStore",
    "MilvusBackend",
    "MilvusClient",
    "StorageContext",
    "VectorStoreIndex",
]
