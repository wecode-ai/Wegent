# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pandoc document processing pipeline.

This pipeline uses pypandoc (Python wrapper for Pandoc) to convert Office documents
(DOC, DOCX, PPT, PPTX) to Markdown, then uses the MarkdownProcessor
for intelligent Markdown-aware chunking with preprocessing and context injection.

pypandoc can automatically download Pandoc if it's not installed on the system,
making deployment easier without requiring system-level Pandoc installation.
"""

import logging
import os
import tempfile
from pathlib import Path
from typing import List, Optional

from llama_index.core import Document

from app.services.rag.pipeline.base import BaseDocumentPipeline

logger = logging.getLogger(__name__)


class PandocNotFoundError(Exception):
    """Raised when Pandoc is not installed or not found."""

    pass


class PandocConversionError(Exception):
    """Raised when Pandoc conversion fails."""

    pass


class PandocPipeline(BaseDocumentPipeline):
    """
    Document pipeline using pypandoc for Office document conversion.

    This pipeline converts DOC, DOCX, PPT, and PPTX files to Markdown
    using pypandoc (Python wrapper for Pandoc), then applies Markdown-aware
    splitting for optimal chunking.

    pypandoc advantages:
    - Pure Python interface (no subprocess calls)
    - Can automatically download Pandoc binary if not installed
    - Easier deployment in containerized environments

    Suitable for:
    - DOC/DOCX files (Word documents)
    - PPT/PPTX files (PowerPoint presentations)
    """

    # File extensions handled by this pipeline
    SUPPORTED_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx"}

    # Pandoc input format mapping
    INPUT_FORMAT_MAP = {
        ".doc": "doc",
        ".docx": "docx",
        ".ppt": "pptx",  # Pandoc uses pptx for both
        ".pptx": "pptx",
    }

    # Flag to track if we've already tried to ensure Pandoc is available
    _pandoc_ensured = False

    def __init__(
        self,
        chunk_size: int = BaseDocumentPipeline.DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = BaseDocumentPipeline.DEFAULT_CHUNK_OVERLAP,
    ):
        """
        Initialize Pandoc pipeline.

        Args:
            chunk_size: Maximum chunk size in characters
            chunk_overlap: Number of characters to overlap between chunks

        Raises:
            PandocNotFoundError: If Pandoc cannot be found or downloaded
        """
        super().__init__(chunk_size, chunk_overlap)
        self._ensure_pandoc_available()

    @classmethod
    def get_supported_extensions(cls) -> set:
        """Get supported file extensions."""
        return cls.SUPPORTED_EXTENSIONS

    @classmethod
    def _ensure_pandoc_available(cls) -> None:
        """
        Ensure Pandoc is available, downloading if necessary.

        This method checks if Pandoc is installed. If not, it attempts
        to download it using pypandoc's download functionality.
        """
        if cls._pandoc_ensured:
            return

        try:
            import pypandoc

            # Try to get Pandoc version to check if it's available
            try:
                version = pypandoc.get_pandoc_version()
                logger.info(f"Pandoc version {version} is available")
                cls._pandoc_ensured = True
                return
            except OSError:
                # Pandoc not found, try to download it
                logger.warning("Pandoc not found, attempting to download...")

            # Download Pandoc binary
            try:
                pypandoc.download_pandoc()
                version = pypandoc.get_pandoc_version()
                logger.info(f"Successfully downloaded Pandoc version {version}")
                cls._pandoc_ensured = True
            except Exception as e:
                raise PandocNotFoundError(
                    f"Failed to download Pandoc: {e}. "
                    "Please install Pandoc manually: https://pandoc.org/installing.html"
                ) from e

        except ImportError as e:
            raise PandocNotFoundError(
                "pypandoc is not installed. Please install it: pip install pypandoc"
            ) from e

    @classmethod
    def is_pandoc_available(cls) -> bool:
        """
        Check if Pandoc is available on the system.

        Returns:
            True if Pandoc is installed and accessible
        """
        try:
            import pypandoc

            pypandoc.get_pandoc_version()
            return True
        except (ImportError, OSError):
            return False

    def _get_pandoc_version(self) -> Optional[str]:
        """
        Get the installed Pandoc version.

        Returns:
            Version string or None if unable to determine
        """
        try:
            import pypandoc

            return pypandoc.get_pandoc_version()
        except Exception as e:
            logger.warning(f"Failed to get Pandoc version: {e}")
            return None

    def read(self, binary_data: bytes, file_extension: str) -> bytes:
        """
        Pass through binary data.

        Pandoc conversion happens in the convert stage.

        Args:
            binary_data: Raw binary file content
            file_extension: File extension

        Returns:
            Unchanged binary data
        """
        return binary_data

    def convert(self, content: bytes, file_extension: str) -> str:
        """
        Convert Office document to Markdown using pypandoc.

        This method writes the binary data to a temporary file,
        uses pypandoc to convert it to Markdown, and returns
        the converted text.

        For PPT/PPTX files, also removes Pandoc-generated "Slide X" headers.

        Args:
            content: Binary file content
            file_extension: File extension for format detection

        Returns:
            Markdown text content

        Raises:
            PandocConversionError: If conversion fails
        """
        try:
            import pypandoc
        except ImportError as e:
            raise PandocConversionError(
                "pypandoc is not installed. Please install it: pip install pypandoc"
            ) from e

        ext = file_extension.lower()
        input_format = self.INPUT_FORMAT_MAP.get(ext)

        if not input_format:
            raise PandocConversionError(
                f"Unsupported file extension for Pandoc: {file_extension}"
            )

        input_path = None

        try:
            # Create temporary file for input
            with tempfile.NamedTemporaryFile(
                suffix=file_extension, delete=False
            ) as input_file:
                input_file.write(content)
                input_path = input_file.name

            # Convert using pypandoc
            # extra_args: --wrap=none disables line wrapping for better splitting
            markdown_content = pypandoc.convert_file(
                input_path,
                to="markdown",
                format=input_format,
                extra_args=["--wrap=none"],
            )

            # Note: Preserve Pandoc-generated slide headers (e.g., "## Slide 1")
            # These headers serve as natural splitting points for RAG chunking
            # and help maintain slide structure in the processed content
            # They will be used by MarkdownProcessor for header-based splitting

            logger.info(
                f"Pandoc conversion successful: {len(content)} bytes -> "
                f"{len(markdown_content)} characters"
            )

            return markdown_content

        except RuntimeError as e:
            raise PandocConversionError(f"Pandoc conversion failed: {e}") from e
        except Exception as e:
            raise PandocConversionError(
                f"Unexpected error during Pandoc conversion: {e}"
            ) from e
        finally:
            # Clean up temporary file
            if input_path:
                try:
                    Path(input_path).unlink(missing_ok=True)
                except Exception as e:
                    logger.warning(f"Failed to delete temporary file {input_path}: {e}")

    def split(self, text_content: str, document_title: str = "") -> List[Document]:
        """
        Split Markdown content into Document chunks.

        Uses MarkdownProcessor for intelligent markdown chunking with:
        - Table protection (tables are preserved, not converted)
        - Noise removal (horizontal rules, empty links, HTML comments)
        - Code block protection (never split code blocks)
        - Header-based splitting (H1-H3)
        - Small chunk merging (< 256 chars)
        - Large chunk splitting (> chunk_size)
        - Context prefix injection (document title + header hierarchy)

        Args:
            text_content: Markdown text content
            document_title: Optional document title for context prefix

        Returns:
            List of Document objects
        """
        if not text_content.strip():
            logger.warning("Empty text content received for splitting")
            return []

        from app.services.rag.splitter.markdown_processor import MarkdownProcessor

        processor = MarkdownProcessor(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )

        documents = processor.process(text_content, document_title=document_title)

        logger.info(f"Pandoc split created {len(documents)} chunks")

        return documents
