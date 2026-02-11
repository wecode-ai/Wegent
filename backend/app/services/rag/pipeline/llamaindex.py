# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
LlamaIndex document processing pipeline.

This pipeline uses LlamaIndex's SimpleDirectoryReader for document parsing
and the existing splitter infrastructure for chunking. It serves as the
default pipeline for file types that don't require special conversion.
"""

import logging
import tempfile
from pathlib import Path
from typing import List

from llama_index.core import Document, SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter

from app.services.rag.pipeline.base import BaseDocumentPipeline
from app.services.rag.splitter.smart import SmartSplitter

logger = logging.getLogger(__name__)


class LlamaIndexPipeline(BaseDocumentPipeline):
    """
    Document pipeline using LlamaIndex's built-in parsing capabilities.

    This pipeline leverages SimpleDirectoryReader to parse various document
    formats (PDF, TXT, MD, etc.) and uses SmartSplitter or SentenceSplitter
    for chunking based on file type.

    Suitable for:
    - PDF files (when Docling is not configured)
    - TXT files
    - Markdown files
    - Other formats supported by LlamaIndex
    """

    # File extensions handled by this pipeline
    SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".json", ".csv"}

    def __init__(
        self,
        file_extension: str,
        chunk_size: int = BaseDocumentPipeline.DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = BaseDocumentPipeline.DEFAULT_CHUNK_OVERLAP,
    ):
        """
        Initialize LlamaIndex pipeline.

        Args:
            file_extension: File extension for splitter strategy selection
            chunk_size: Maximum chunk size in characters
            chunk_overlap: Number of characters to overlap between chunks
        """
        super().__init__(chunk_size, chunk_overlap)
        self.file_extension = file_extension.lower()

    @classmethod
    def get_supported_extensions(cls) -> set:
        """Get supported file extensions."""
        return cls.SUPPORTED_EXTENSIONS

    def read(self, binary_data: bytes, file_extension: str) -> bytes:
        """
        Pass through binary data for LlamaIndex processing.

        LlamaIndex's SimpleDirectoryReader handles file reading internally,
        so this stage simply returns the binary data unchanged.

        Args:
            binary_data: Raw binary file content
            file_extension: File extension

        Returns:
            Unchanged binary data
        """
        return binary_data

    def convert(self, content: bytes, file_extension: str) -> str:
        """
        Convert binary content to text using LlamaIndex.

        This method writes the binary data to a temporary file and uses
        SimpleDirectoryReader to extract text content.

        Args:
            content: Binary file content
            file_extension: File extension for format detection

        Returns:
            Extracted text content
        """
        # Write to temporary file for SimpleDirectoryReader
        with tempfile.NamedTemporaryFile(
            suffix=file_extension, delete=False
        ) as tmp_file:
            tmp_file.write(content)
            tmp_file_path = tmp_file.name

        try:
            # Use LlamaIndex to parse the document
            documents = SimpleDirectoryReader(input_files=[tmp_file_path]).load_data()

            # Combine all document texts
            text_parts = []
            for doc in documents:
                if doc.text:
                    text_parts.append(doc.text)

            return "\n\n".join(text_parts)

        finally:
            # Clean up temporary file
            try:
                Path(tmp_file_path).unlink()
            except Exception as e:
                logger.warning(f"Failed to delete temporary file {tmp_file_path}: {e}")

    def split(self, text_content: str) -> List[Document]:
        """
        Split text content into Document chunks.

        Uses SmartSplitter for appropriate chunking based on file type,
        or SentenceSplitter as fallback.

        Args:
            text_content: Text content to split

        Returns:
            List of Document objects
        """
        if not text_content.strip():
            logger.warning("Empty text content received for splitting")
            return []

        # Create a Document from the text content
        doc = Document(text=text_content)

        # Use SmartSplitter if file type is supported
        if SmartSplitter.supports_smart_split(self.file_extension):
            splitter = SmartSplitter(
                file_extension=self.file_extension,
                chunk_size=self.chunk_size,
                chunk_overlap=self.chunk_overlap,
            )
            nodes = splitter.split_documents([doc])
        else:
            # Fallback to sentence splitting
            sentence_splitter = SentenceSplitter(
                chunk_size=self.chunk_size,
                chunk_overlap=self.chunk_overlap,
            )
            nodes = sentence_splitter.get_nodes_from_documents([doc])

        # Convert nodes back to Documents
        return [
            Document(
                text=node.text,
                metadata=node.metadata if hasattr(node, "metadata") else {},
            )
            for node in nodes
        ]

    def process(
        self, binary_data: bytes, file_extension: str, source_file: str = ""
    ) -> List[Document]:
        """
        Process document using optimized LlamaIndex flow.

        This overrides the base process method to provide a more efficient
        flow that avoids unnecessary text extraction when we can directly
        use SimpleDirectoryReader's document output.

        Args:
            binary_data: Raw binary file content
            file_extension: File extension
            source_file: Original filename for metadata

        Returns:
            List of Document objects
        """
        logger.info(
            f"Processing document with LlamaIndexPipeline: "
            f"extension={file_extension}, size={len(binary_data)} bytes"
        )

        # Write to temporary file
        with tempfile.NamedTemporaryFile(
            suffix=file_extension, delete=False
        ) as tmp_file:
            tmp_file.write(binary_data)
            tmp_file_path = tmp_file.name

        try:
            # Parse document with LlamaIndex
            documents = SimpleDirectoryReader(input_files=[tmp_file_path]).load_data()

            # Update metadata
            if source_file:
                filename_without_ext = Path(source_file).stem
                for doc in documents:
                    if doc.metadata is None:
                        doc.metadata = {}
                    doc.metadata["filename"] = filename_without_ext
                    doc.metadata["source_file"] = source_file
                    doc.metadata["pipeline"] = self.__class__.__name__

            # Split documents
            if SmartSplitter.supports_smart_split(file_extension):
                splitter = SmartSplitter(
                    file_extension=file_extension,
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                )
                nodes = splitter.split_documents(documents)
            else:
                sentence_splitter = SentenceSplitter(
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                )
                nodes = sentence_splitter.get_nodes_from_documents(documents)

            logger.info(f"LlamaIndexPipeline created {len(nodes)} chunks")

            # Convert nodes to Documents
            result_docs = []
            for node in nodes:
                doc = Document(
                    text=node.text,
                    metadata=node.metadata if hasattr(node, "metadata") else {},
                )
                if source_file and "source_file" not in doc.metadata:
                    doc.metadata["source_file"] = source_file
                    doc.metadata["pipeline"] = self.__class__.__name__
                result_docs.append(doc)

            return result_docs

        finally:
            # Clean up
            try:
                Path(tmp_file_path).unlink()
            except Exception as e:
                logger.warning(f"Failed to delete temporary file {tmp_file_path}: {e}")
