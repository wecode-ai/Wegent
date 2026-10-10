# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage interfaces for knowledge_engine."""

from __future__ import annotations

from typing import Any

from knowledge_engine.lazy_exports import lazy_export_names, resolve_lazy_export

# Backend implementations import llama-index, pymilvus, qdrant and
# elasticsearch. Keeping the exports lazy lets capability-only callers import
# this package without loading those heavy dependencies.
_LAZY_EXPORTS = {
    "BaseStorageBackend": "knowledge_engine.storage.base",
    "ChunkMetadata": "knowledge_engine.storage.chunk_metadata",
    "ElasticsearchBackend": "knowledge_engine.storage.elasticsearch_backend",
    "MilvusBackend": "knowledge_engine.storage.milvus_backend",
    "QdrantBackend": "knowledge_engine.storage.qdrant_backend",
    "create_storage_backend_from_config": "knowledge_engine.storage.factory",
    "create_storage_backend_from_runtime_config": "knowledge_engine.storage.factory",
    "get_supported_storage_types": "knowledge_engine.storage.factory",
}

__all__ = lazy_export_names(_LAZY_EXPORTS)


def __getattr__(name: str) -> Any:
    return resolve_lazy_export(__name__, _LAZY_EXPORTS, name)


def __dir__() -> list[str]:
    return lazy_export_names(_LAZY_EXPORTS)
