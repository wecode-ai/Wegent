# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart document splitter that automatically selects the best splitting strategy
based on file type.

Supported file types and their strategies:
- .md: Enhanced markdown processing with preprocessing, header-based splitting,
       chunk merging/splitting, and context prefix injection
- .txt: Sentence-based splitting
- .pdf, .doc, .docx, .ppt, .pptx: Recursive character splitting (via LangChain)
"""

from typing import List

from langchain_text_splitters import RecursiveCharacterTextSplitter
from llama_index.core import Document
from llama_index.core.node_parser import (
    LangchainNodeParser,
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
    - PDF/DOC/DOCX/PPT/PPTX: Uses recursive character splitting via LangChain

    All strategies use unified chunk_size=1024 and chunk_overlap=50.

    Note: For Office documents (DOC, DOCX, PPT, PPTX), the DocumentIndexer
    may use the pipeline architecture (Pandoc) to convert them
    to Markdown first, which provides better structure preservation.
    """

    # File extensions that support smart splitting
    SMART_EXTENSIONS = {".pdf", ".txt", ".doc", ".docx", ".ppt", ".pptx", ".md"}

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
            # PDF, DOC, DOCX, PPT, PPTX use recursive character splitting
            return self._split_recursive(documents)

    def _split_markdown(self, documents: List[Document]) -> List[BaseNode]:
        """Split markdown documents using enhanced MarkdownProcessor.

        Uses MarkdownProcessor for intelligent markdown chunking with:
        - Table conversion to key-value format
        - Noise removal (horizontal rules, empty links, HTML comments)
        - Code block protection (never split code blocks)
        - Header-based splitting (H1-H3)
        - Small chunk merging (< 256 chars)
        - Large chunk splitting (> chunk_size)
        - Context prefix injection (document title + header hierarchy)

        Args:
            documents: List of Document objects

        Returns:
            List of BaseNode objects
        """
        from llama_index.core.schema import TextNode

        from app.services.rag.splitter.markdown_processor import MarkdownProcessor

        processor = MarkdownProcessor(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )

        result_nodes: List[BaseNode] = []

        for doc in documents:
            # Extract document title from metadata or filename
            document_title = doc.metadata.get(
                "source_file", doc.metadata.get("filename", "")
            )

            # Process markdown with enhanced processor
            processed_docs = processor.process(doc.text, document_title)

            # Convert to TextNode objects
            for processed_doc in processed_docs:
                # Merge original metadata with new metadata
                merged_metadata = {**doc.metadata, **processed_doc.metadata}
                result_nodes.append(
                    TextNode(text=processed_doc.text, metadata=merged_metadata)
                )

        return result_nodes

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
            return "markdown_enhanced"
        elif self.file_extension == ".txt":
            return "sentence"
        else:
            return "recursive_character"
