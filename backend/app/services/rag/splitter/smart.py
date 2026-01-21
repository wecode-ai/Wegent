# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart Splitter for document chunking.

Automatically selects the best splitter based on file type:
- .md files: MarkdownNodeParser + SentenceSplitter chain (parse structure first, then split)
- .txt files: TokenTextSplitter with fixed configuration
- .pdf files: RecursiveCharacterTextSplitter from LangChain
- .docx/.doc files: RecursiveCharacterTextSplitter from LangChain
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Tuple

from langchain_text_splitters import RecursiveCharacterTextSplitter
from llama_index.core import Document
from llama_index.core.node_parser import (
    MarkdownNodeParser,
)
from llama_index.core.node_parser import SentenceSplitter as LlamaIndexSentenceSplitter
from llama_index.core.node_parser import (
    TokenTextSplitter as LlamaIndexTokenTextSplitter,
)
from llama_index.core.schema import BaseNode, TextNode

from app.services.rag.utils.tokenizer import count_tokens

logger = logging.getLogger(__name__)

# Supported file extensions for smart splitting
SMART_SUPPORTED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx", ".doc"}

# TXT splitter configuration (fixed internally)
TXT_CHUNK_SIZE = 1024
TXT_CHUNK_OVERLAP = 20

# MD splitter configuration (fixed internally)
# MarkdownNodeParser parses structure, then SentenceSplitter splits into chunks
MD_CHUNK_SIZE = 1024
MD_CHUNK_OVERLAP = 50

# PDF splitter configuration (fixed internally)
PDF_CHUNK_SIZE = 1024
PDF_CHUNK_OVERLAP = 20

# DOCX splitter configuration (fixed internally)
DOCX_CHUNK_SIZE = 1024
DOCX_CHUNK_OVERLAP = 20


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
    - .md files: MarkdownNodeParser + SentenceSplitter chain
      (first parse markdown structure, then split into fixed-size chunks)
    - .txt files: TokenTextSplitter with fixed chunk_size=1024, chunk_overlap=20
    - .pdf files: RecursiveCharacterTextSplitter with chunk_size=1024, chunk_overlap=20
    - .docx/.doc files: RecursiveCharacterTextSplitter with chunk_size=1024, chunk_overlap=20
    """

    def __init__(self, file_extension: str, embedding_model_name: str = ""):
        """
        Initialize smart splitter.

        Args:
            file_extension: File extension (e.g., '.md', '.txt', '.pdf', '.docx')
            embedding_model_name: Name of embedding model for token counting
        """
        self.file_extension = file_extension.lower()
        self.embedding_model_name = embedding_model_name

        # Normalize extension
        if not self.file_extension.startswith("."):
            self.file_extension = f".{self.file_extension}"

        # Create appropriate splitter(s)
        if self.file_extension == ".md":
            # For markdown: use MarkdownNodeParser first, then SentenceSplitter
            self.markdown_parser = MarkdownNodeParser(
                include_metadata=True,
                include_prev_next_rel=True,
            )
            self.sentence_splitter = LlamaIndexSentenceSplitter(
                chunk_size=MD_CHUNK_SIZE,
                chunk_overlap=MD_CHUNK_OVERLAP,
            )
            self.splitter_subtype = "markdown_sentence"
        elif self.file_extension == ".txt":
            # For TXT: use TokenTextSplitter
            self.splitter = LlamaIndexTokenTextSplitter(
                chunk_size=TXT_CHUNK_SIZE,
                chunk_overlap=TXT_CHUNK_OVERLAP,
            )
            self.splitter_subtype = "token"
        elif self.file_extension == ".pdf":
            # For PDF: use LangChain RecursiveCharacterTextSplitter
            self.langchain_splitter = RecursiveCharacterTextSplitter(
                chunk_size=PDF_CHUNK_SIZE,
                chunk_overlap=PDF_CHUNK_OVERLAP,
            )
            self.splitter_subtype = "recursive_character"
        elif self.file_extension in {".docx", ".doc"}:
            # For DOCX/DOC: use LangChain RecursiveCharacterTextSplitter
            self.langchain_splitter = RecursiveCharacterTextSplitter(
                chunk_size=DOCX_CHUNK_SIZE,
                chunk_overlap=DOCX_CHUNK_OVERLAP,
            )
            self.splitter_subtype = "recursive_character"
        else:
            raise ValueError(
                f"Smart splitter not supported for file extension: {self.file_extension}. "
                f"Supported extensions: {SMART_SUPPORTED_EXTENSIONS}"
            )

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Split documents into nodes using smart splitting.

        For markdown files: first parse with MarkdownNodeParser to preserve structure,
        then split with SentenceSplitter to ensure consistent chunk sizes.
        For PDF/DOCX files: use LangChain RecursiveCharacterTextSplitter and convert
        results to LlamaIndex TextNode format.

        Args:
            documents: List of documents to split

        Returns:
            List of nodes
        """
        if self.file_extension == ".md":
            # Chain: MarkdownNodeParser -> SentenceSplitter
            markdown_nodes = self.markdown_parser.get_nodes_from_documents(documents)
            # Apply SentenceSplitter to the markdown nodes
            chunked_nodes = self.sentence_splitter.get_nodes_from_documents(
                markdown_nodes
            )
            return chunked_nodes
        elif self.file_extension == ".txt":
            # For txt files, use TokenTextSplitter
            return self.splitter.get_nodes_from_documents(documents)
        elif self.file_extension in {".pdf", ".docx", ".doc"}:
            # For PDF/DOCX files, use LangChain splitter and convert to TextNodes
            return self._split_with_langchain(documents)
        else:
            raise ValueError(f"Unsupported file extension: {self.file_extension}")

    def _split_with_langchain(self, documents: List[Document]) -> List[BaseNode]:
        """
        Split documents using LangChain RecursiveCharacterTextSplitter.

        Extracts text content from LlamaIndex Documents, splits with LangChain,
        and converts results back to LlamaIndex TextNode format.

        Args:
            documents: List of LlamaIndex Document objects

        Returns:
            List of LlamaIndex TextNode objects
        """
        nodes = []
        for doc in documents:
            # Get text content from LlamaIndex Document
            text_content = doc.get_content()
            if not text_content.strip():
                continue

            # Split using LangChain splitter
            chunks = self.langchain_splitter.split_text(text_content)

            # Convert to LlamaIndex TextNodes
            for chunk in chunks:
                if chunk.strip():
                    node = TextNode(
                        text=chunk,
                        metadata=doc.metadata.copy() if doc.metadata else {},
                    )
                    nodes.append(node)

        return nodes

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
        config = {
            "type": "smart",
            "file_extension": self.file_extension,
            "splitter_subtype": self.splitter_subtype,
        }
        if self.file_extension == ".md":
            config["chunk_size"] = MD_CHUNK_SIZE
            config["chunk_overlap"] = MD_CHUNK_OVERLAP
        elif self.file_extension == ".txt":
            config["chunk_size"] = TXT_CHUNK_SIZE
            config["chunk_overlap"] = TXT_CHUNK_OVERLAP
        elif self.file_extension == ".pdf":
            config["chunk_size"] = PDF_CHUNK_SIZE
            config["chunk_overlap"] = PDF_CHUNK_OVERLAP
        elif self.file_extension in {".docx", ".doc"}:
            config["chunk_size"] = DOCX_CHUNK_SIZE
            config["chunk_overlap"] = DOCX_CHUNK_OVERLAP
        return config


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
