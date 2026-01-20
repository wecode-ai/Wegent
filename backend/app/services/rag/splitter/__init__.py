# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Splitter module for document chunking.

This module provides various document splitting strategies:
- SemanticSplitter: Embedding-based semantic splitting
- SentenceSplitter: Sentence/text-based splitting
- StructuralSemanticSplitter: Seven-phase pipeline for structure-aware splitting

Enhanced components:
- LLMChunkingGate: Statistics-based decision for LLM vs rule-based chunking
- SemanticTokenSplitter: Token splitting with overflow strategies
- SemanticChunkValidator: Chunk validation with coverage and title_strict modes
"""

from app.services.rag.splitter.chunkers import (
    APIRuleBasedChunker,
    LLMChunkingGate,
    SemanticTokenSplitter,
    StructuralChunker,
    TokenSplitter,
)
from app.services.rag.splitter.models import (
    APIDocumentInfo,
    APIEndpoint,
    APISection,
    BlockType,
    ChunkItem,
    DocumentChunks,
    DocumentIR,
    SemanticChunk,
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
from app.services.rag.splitter.validators import (
    SemanticChunkValidator,
    ValidationResult,
)

__all__ = [
    # Splitters
    "DocumentSplitter",
    "SemanticSplitter",
    "SentenceSplitter",
    "StructuralSemanticSplitter",
    # Chunkers
    "APIRuleBasedChunker",
    "LLMChunkingGate",
    "SemanticTokenSplitter",
    "StructuralChunker",
    "TokenSplitter",
    # Validators
    "SemanticChunkValidator",
    "ValidationResult",
    # Data models
    "APIDocumentInfo",
    "APIEndpoint",
    "APISection",
    "BlockType",
    "ChunkItem",
    "DocumentChunks",
    "DocumentIR",
    "SemanticChunk",
    "SkippedElement",
    "SkippedElementType",
    "StructureBlock",
    # Utilities
    "is_structural_semantic_supported",
]
