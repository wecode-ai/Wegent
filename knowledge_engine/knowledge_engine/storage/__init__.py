# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage interfaces for knowledge_engine."""

from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata

__all__ = ["BaseStorageBackend", "ChunkMetadata"]
