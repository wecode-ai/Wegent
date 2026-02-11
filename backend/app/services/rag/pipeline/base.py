# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base abstract class for document processing pipelines.

A document pipeline consists of three stages:
1. Read: Load raw binary data from file
2. Convert: Transform content to Markdown (if applicable)
3. Split: Chunk the content into Document nodes

Different implementations handle different file types and conversion methods.
"""

import logging
from abc import ABC, abstractmethod
from typing import List

from llama_index.core import Document

logger = logging.getLogger(__name__)


class BaseDocumentPipeline(ABC):
    """
    Abstract base class for document processing pipelines.

    Subclasses implement specific strategies for reading, converting,
    and splitting different document types (e.g., LlamaIndex for general files,
    Pandoc for Office documents, Docling for advanced document conversion).

    Attributes:
        chunk_size: Maximum chunk size in characters (default: 1024)
        chunk_overlap: Number of characters to overlap between chunks (default: 50)
    """

    DEFAULT_CHUNK_SIZE = 1024
    DEFAULT_CHUNK_OVERLAP = 50

    def __init__(
        self,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    ):
        """
        Initialize the document pipeline.

        Args:
            chunk_size: Maximum chunk size in characters
            chunk_overlap: Number of characters to overlap between chunks
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    @abstractmethod
    def read(self, binary_data: bytes, file_extension: str) -> bytes:
        """
        Read and prepare raw file content.

        This stage may perform initial processing of the binary data,
        such as decompression or format validation.

        Args:
            binary_data: Raw binary file content
            file_extension: File extension (e.g., '.docx', '.pdf')

        Returns:
            Processed binary data ready for conversion

        Raises:
            ValueError: If file format is not supported
            IOError: If file cannot be read
        """
        pass

    @abstractmethod
    def convert(self, content: bytes, file_extension: str) -> str:
        """
        Convert file content to Markdown or plain text.

        This stage transforms the raw content into a text format
        suitable for splitting. Some pipelines (like LlamaIndex)
        may not perform actual conversion.

        Args:
            content: Binary content from read stage
            file_extension: File extension for format detection

        Returns:
            Text content (Markdown or plain text)

        Raises:
            RuntimeError: If conversion fails
        """
        pass

    @abstractmethod
    def split(self, text_content: str) -> List[Document]:
        """
        Split text content into Document chunks.

        This stage breaks the text into smaller pieces suitable
        for embedding and retrieval.

        Args:
            text_content: Text content from convert stage

        Returns:
            List of LlamaIndex Document objects

        Raises:
            ValueError: If text content is empty
        """
        pass

    def process(
        self, binary_data: bytes, file_extension: str, source_file: str = ""
    ) -> List[Document]:
        """
        Execute the full document processing pipeline.

        This method orchestrates the read -> convert -> split flow,
        providing consistent error handling and logging.

        Args:
            binary_data: Raw binary file content
            file_extension: File extension (e.g., '.docx', '.pdf')
            source_file: Original filename for metadata (optional)

        Returns:
            List of LlamaIndex Document objects with metadata

        Raises:
            Exception: If any pipeline stage fails
        """
        logger.info(
            f"Processing document: extension={file_extension}, "
            f"size={len(binary_data)} bytes, pipeline={self.__class__.__name__}"
        )

        # Stage 1: Read
        content = self.read(binary_data, file_extension)
        logger.debug(f"Read stage completed: {len(content)} bytes")

        # Stage 2: Convert
        text_content = self.convert(content, file_extension)
        logger.debug(f"Convert stage completed: {len(text_content)} characters")

        # Stage 3: Split
        documents = self.split(text_content)
        logger.info(f"Split stage completed: {len(documents)} documents created")

        # Add source file metadata to all documents
        if source_file:
            for doc in documents:
                if doc.metadata is None:
                    doc.metadata = {}
                doc.metadata["source_file"] = source_file
                doc.metadata["pipeline"] = self.__class__.__name__

        return documents

    @classmethod
    def get_supported_extensions(cls) -> set:
        """
        Get the set of file extensions supported by this pipeline.

        Subclasses should override this method to declare their
        supported file types.

        Returns:
            Set of supported file extensions (e.g., {'.pdf', '.docx'})
        """
        return set()

    @classmethod
    def supports_extension(cls, file_extension: str) -> bool:
        """
        Check if this pipeline supports the given file extension.

        Args:
            file_extension: File extension to check

        Returns:
            True if the extension is supported
        """
        return file_extension.lower() in cls.get_supported_extensions()
