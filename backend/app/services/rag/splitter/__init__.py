# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Splitter module for document chunking.
"""

from app.services.rag.splitter.smart import (
    ChunkItem,
    SmartChunksData,
    SmartSplitter,
    is_smart_splitter_supported,
)
from app.services.rag.splitter.splitter import (
    DocumentSplitter,
    SemanticSplitter,
    SentenceSplitter,
)
from app.services.rag.splitter.validators import (
    MARKDOWN_MAX_CHUNK_TOKENS,
    OversizedChunk,
    ValidationResult,
    format_validation_error,
    validate_markdown_chunks,
)

__all__ = [
    "DocumentSplitter",
    "SemanticSplitter",
    "SentenceSplitter",
    "SmartSplitter",
    "ChunkItem",
    "SmartChunksData",
    "is_smart_splitter_supported",
    "MARKDOWN_MAX_CHUNK_TOKENS",
    "OversizedChunk",
    "ValidationResult",
    "format_validation_error",
    "validate_markdown_chunks",
]
