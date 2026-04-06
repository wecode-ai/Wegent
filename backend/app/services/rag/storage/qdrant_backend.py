# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backward-compatible re-export of the engine Qdrant backend."""

from knowledge_engine.storage.qdrant_backend import (
    QdrantBackend,
    QdrantClient,
    QdrantVectorStore,
)

__all__ = ["QdrantBackend", "QdrantClient", "QdrantVectorStore"]
