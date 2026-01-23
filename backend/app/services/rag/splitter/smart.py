# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart document splitter that automatically selects the best splitting strategy
based on file type.

Supported file types and their strategies:
- .md: Markdown structure splitting + sentence splitting
- .txt: Sentence-based splitting
- .pdf, .doc, .docx: Recursive character splitting (via LangChain)
"""

from typing import List

from langchain_text_splitters import RecursiveCharacterTextSplitter
from llama_index.core import Document
from llama_index.core.node_parser import (
    LangchainNodeParser,
    MarkdownNodeParser,
    SentenceSplitter,
)
from llama_index.core.schema import BaseNode

from shared.telemetry.decorators import set_span_attribute, trace_sync


class SmartSplitter:
    """Smart splitter that selects splitting strategy based on file type.

    Uses different splitting strategies for different file types:
    - Markdown (.md): First splits by markdown structure (headers), then
      applies sentence splitting for large sections
    - Text (.txt): Uses sentence-based splitting
    - PDF/DOC/DOCX: Uses recursive character splitting via LangChain

    All strategies use unified chunk_size=1024 and chunk_overlap=50.
    """

    # File extensions that support smart splitting
    SMART_EXTENSIONS = {".pdf", ".txt", ".doc", ".docx", ".md"}

    # Default configuration
    DEFAULT_CHUNK_SIZE = 1024
    DEFAULT_CHUNK_OVERLAP = 50

    def __init__(
        self,
        file_extension: str,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    ):
        """Initialize smart splitter.

        Args:
            file_extension: File extension (e.g., '.pdf', '.md')
            chunk_size: Maximum chunk size in characters (default: 1024)
            chunk_overlap: Number of characters to overlap between chunks (default: 50)
        """
        self.file_extension = file_extension.lower()
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    @classmethod
    def supports_smart_split(cls, file_extension: str) -> bool:
        """Check if file type supports smart splitting.

        Args:
            file_extension: File extension to check

        Returns:
            True if smart splitting is supported for this file type
        """
        return file_extension.lower() in cls.SMART_EXTENSIONS

    @trace_sync("rag.splitter.split_documents")
    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """Split documents using the appropriate strategy for the file type.

        Args:
            documents: List of LlamaIndex Document objects to split

        Returns:
            List of BaseNode objects (chunks)
        """
        # Add span attributes for observability
        set_span_attribute("file_extension", self.file_extension)
        set_span_attribute("chunk_size", self.chunk_size)
        set_span_attribute("chunk_overlap", self.chunk_overlap)

        if self.file_extension == ".md":
            return self._split_markdown(documents)
        elif self.file_extension == ".txt":
            return self._split_text(documents)
        else:
            # PDF, DOC, DOCX use recursive character splitting
            return self._split_recursive(documents)

    def _split_markdown(self, documents: List[Document]) -> List[BaseNode]:
        """Split markdown documents.

        Uses MarkdownNodeParser to split by structure (headers), then
        applies SentenceSplitter to break down large sections.

        Args:
            documents: List of Document objects

        Returns:
            List of BaseNode objects
        """
        # First pass: Split by markdown structure (headers)
        markdown_parser = MarkdownNodeParser()
        nodes = markdown_parser.get_nodes_from_documents(documents)

        # Second pass: Apply sentence splitting to large nodes
        sentence_splitter = SentenceSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )

        # Convert nodes back to documents for second pass
        intermediate_docs = [
            Document(text=node.text, metadata=node.metadata) for node in nodes
        ]

        return sentence_splitter.get_nodes_from_documents(intermediate_docs)

    def _split_text(self, documents: List[Document]) -> List[BaseNode]:
        """Split text documents using sentence-based splitting.

        Args:
            documents: List of Document objects

        Returns:
            List of BaseNode objects
        """
        splitter = SentenceSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )
        return splitter.get_nodes_from_documents(documents)

    def _split_recursive(self, documents: List[Document]) -> List[BaseNode]:
        """Split documents using recursive character splitting.

        Uses LangChain's RecursiveCharacterTextSplitter via LangchainNodeParser.
        This is suitable for PDF and DOC/DOCX files that have been converted
        to plain text.

        Args:
            documents: List of Document objects

        Returns:
            List of BaseNode objects
        """
        # Create LangChain splitter with hierarchical separators
        lc_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            separators=["\n\n", "\n", " ", ""],
        )

        # Wrap in LlamaIndex parser
        parser = LangchainNodeParser(lc_splitter=lc_splitter)
        return parser.get_nodes_from_documents(documents)

    @trace_sync("rag.splitter.get_config")
    def get_config(self) -> dict:
        """Get splitter configuration for storage.

        Returns:
            Configuration dict with type and parameters
        """
        # Add span attributes for observability
        set_span_attribute("file_extension", self.file_extension)
        set_span_attribute("chunk_size", self.chunk_size)
        set_span_attribute("chunk_overlap", self.chunk_overlap)

        return {
            "type": "smart",
            "subtype": self._get_subtype(),
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "file_extension": self.file_extension,
        }

    def _get_subtype(self) -> str:
        """Get the subtype identifier for this splitter.

        Returns:
            Subtype string identifying the splitting strategy
        """
        if self.file_extension == ".md":
            return "markdown_sentence"
        elif self.file_extension == ".txt":
            return "sentence"
        else:
            return "recursive_character"
