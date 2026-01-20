# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Data models for the structural semantic splitter pipeline."""

from .api_models import (
    APIDocumentInfo,
    APIEndpoint,
    APISection,
    SemanticChunk,
)
from .ir import (
    BlockType,
    ChunkItem,
    DocumentChunks,
    DocumentIR,
    SkippedElement,
    SkippedElementType,
    StructureBlock,
)

__all__ = [
    # IR models
    "BlockType",
    "ChunkItem",
    "DocumentChunks",
    "DocumentIR",
    "SkippedElement",
    "SkippedElementType",
    "StructureBlock",
    # API detection models
    "APIDocumentInfo",
    "APIEndpoint",
    "APISection",
    "SemanticChunk",
]
