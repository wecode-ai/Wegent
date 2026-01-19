# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Splitter module for document chunking.

This module provides various document splitting strategies:
- SemanticSplitter: Embedding-based semantic splitting
- SentenceSplitter: Sentence/text-based splitting
- StructuralSemanticSplitter: Six-phase pipeline for structure-aware splitting
"""

from app.services.rag.splitter.models import (
    BlockType,
    ChunkItem,
    DocumentChunks,
    DocumentIR,
    SkippedElement,
    SkippedElementType,
    StructureBlock,
)
from app.services.rag.splitter.splitter import (
    DocumentSplitter,
    SemanticSplitter,
    SentenceSplitter,
)
from app.services.rag.splitter.structural_semantic import (
    StructuralSemanticSplitter,
    is_structural_semantic_supported,
)

__all__ = [
    # Splitters
    "DocumentSplitter",
    "SemanticSplitter",
    "SentenceSplitter",
    "StructuralSemanticSplitter",
    # Data models
    "BlockType",
    "ChunkItem",
    "DocumentChunks",
    "DocumentIR",
    "SkippedElement",
    "SkippedElementType",
    "StructureBlock",
    # Utilities
    "is_structural_semantic_supported",
]
