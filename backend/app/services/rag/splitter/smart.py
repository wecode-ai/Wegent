# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart Splitter for document chunking.

Automatically selects the best splitter based on file type:
- .md files: MarkdownNodeParser with metadata preservation
- .txt files: SentenceSplitter with fixed configuration
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from llama_index.core import Document
from llama_index.core.node_parser import MarkdownNodeParser
from llama_index.core.node_parser import SentenceSplitter as LlamaIndexSentenceSplitter
from llama_index.core.schema import BaseNode, TextNode

from app.services.rag.utils.tokenizer import count_tokens

logger = logging.getLogger(__name__)

# Supported file extensions for smart splitting
SMART_SUPPORTED_EXTENSIONS = {".md", ".txt"}

# TXT splitter configuration (fixed internally)
TXT_CHUNK_SIZE = 1024
TXT_CHUNK_OVERLAP = 128


@dataclass
class ChunkItem:
    """Represents a single chunk of document content."""

    index: int
    content: str
    token_count: int


@dataclass
class SmartChunksData:
    """Container for smart splitter chunks data for DB storage."""

    items: List[ChunkItem] = field(default_factory=list)
    total_count: int = 0
    splitter_type: str = "smart"
    embedding_model: str = ""
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class SmartSplitter:
    """
    Smart document splitter.

    Automatically selects the best splitter based on file type:
    - .md files: MarkdownNodeParser with metadata preservation
    - .txt files: SentenceSplitter with fixed chunk_size=1024, chunk_overlap=128
    """

    def __init__(self, file_extension: str, embedding_model_name: str = ""):
        """
        Initialize smart splitter.

        Args:
            file_extension: File extension (e.g., '.md', '.txt')
            embedding_model_name: Name of embedding model for token counting
        """
        self.file_extension = file_extension.lower()
        self.embedding_model_name = embedding_model_name

        # Normalize extension
        if not self.file_extension.startswith("."):
            self.file_extension = f".{self.file_extension}"

        # Create appropriate splitter
        if self.file_extension == ".md":
            self.splitter = MarkdownNodeParser(
                include_metadata=True,
                include_prev_next_rel=True,
            )
            self.splitter_subtype = "markdown"
        elif self.file_extension == ".txt":
            self.splitter = LlamaIndexSentenceSplitter(
                chunk_size=TXT_CHUNK_SIZE,
                chunk_overlap=TXT_CHUNK_OVERLAP,
            )
            self.splitter_subtype = "sentence"
        else:
            raise ValueError(
                f"Smart splitter not supported for file extension: {self.file_extension}. "
                f"Supported extensions: {SMART_SUPPORTED_EXTENSIONS}"
            )

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Split documents into nodes using smart splitting.

        Args:
            documents: List of documents to split

        Returns:
            List of nodes
        """
        return self.splitter.get_nodes_from_documents(documents)

    def split_documents_with_chunks(
        self, documents: List[Document]
    ) -> Tuple[List[BaseNode], SmartChunksData]:
        """
        Split documents and return both nodes and chunks data for DB storage.

        Args:
            documents: List of LlamaIndex Document objects

        Returns:
            Tuple of (List of TextNode objects, SmartChunksData for DB storage)
        """
        nodes = self.split_documents(documents)

        # Build chunk items for DB storage
        chunk_items = []
        for idx, node in enumerate(nodes):
            content = node.get_content()
            token_count = count_tokens(content, self.embedding_model_name)
            chunk_items.append(
                ChunkItem(
                    index=idx,
                    content=content,
                    token_count=token_count,
                )
            )

        chunks_data = SmartChunksData(
            items=chunk_items,
            total_count=len(chunk_items),
            splitter_type="smart",
            embedding_model=self.embedding_model_name,
        )

        return nodes, chunks_data

    def get_config(self) -> dict:
        """Get splitter configuration."""
        return {
            "type": "smart",
            "file_extension": self.file_extension,
            "splitter_subtype": self.splitter_subtype,
        }


def is_smart_splitter_supported(file_extension: str) -> bool:
    """
    Check if file extension supports smart splitting.

    Args:
        file_extension: File extension (with or without leading dot)

    Returns:
        True if smart splitting is supported
    """
    ext = file_extension.lower()
    if not ext.startswith("."):
        ext = f".{ext}"
    return ext in SMART_SUPPORTED_EXTENSIONS
