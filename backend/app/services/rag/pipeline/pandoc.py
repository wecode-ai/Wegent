# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pandoc document processing pipeline.

This pipeline uses Pandoc (via subprocess) to convert Office documents
(DOC, DOCX, PPT, PPTX) to Markdown, then uses the existing splitter
infrastructure for Markdown-aware chunking.
"""

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional

from llama_index.core import Document
from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter

from app.services.rag.pipeline.base import BaseDocumentPipeline

logger = logging.getLogger(__name__)


class PandocNotFoundError(Exception):
    """Raised when Pandoc is not installed or not found in PATH."""

    pass


class PandocConversionError(Exception):
    """Raised when Pandoc conversion fails."""

    pass


class PandocPipeline(BaseDocumentPipeline):
    """
    Document pipeline using Pandoc for Office document conversion.

    This pipeline converts DOC, DOCX, PPT, and PPTX files to Markdown
    using Pandoc's command-line interface, then applies Markdown-aware
    splitting for optimal chunking.

    Prerequisites:
    - Pandoc must be installed and available in PATH
    - For PPT/PPTX, Pandoc 2.x or higher is recommended

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
            PandocNotFoundError: If Pandoc is not installed
        """
        super().__init__(chunk_size, chunk_overlap)
        self._verify_pandoc_installed()

    @classmethod
    def get_supported_extensions(cls) -> set:
        """Get supported file extensions."""
        return cls.SUPPORTED_EXTENSIONS

    @classmethod
    def is_pandoc_available(cls) -> bool:
        """
        Check if Pandoc is available on the system.

        Returns:
            True if Pandoc is installed and accessible
        """
        return shutil.which("pandoc") is not None

    def _verify_pandoc_installed(self) -> None:
        """
        Verify that Pandoc is installed and accessible.

        Raises:
            PandocNotFoundError: If Pandoc is not found
        """
        if not self.is_pandoc_available():
            raise PandocNotFoundError(
                "Pandoc is not installed or not found in PATH. "
                "Please install Pandoc: https://pandoc.org/installing.html"
            )

    def _get_pandoc_version(self) -> Optional[str]:
        """
        Get the installed Pandoc version.

        Returns:
            Version string or None if unable to determine
        """
        try:
            result = subprocess.run(
                ["pandoc", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                # First line contains version info
                first_line = result.stdout.split("\n")[0]
                return first_line
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
        Convert Office document to Markdown using Pandoc.

        This method writes the binary data to a temporary file,
        invokes Pandoc to convert it to Markdown, and returns
        the converted text.

        Args:
            content: Binary file content
            file_extension: File extension for format detection

        Returns:
            Markdown text content

        Raises:
            PandocConversionError: If conversion fails
        """
        ext = file_extension.lower()
        input_format = self.INPUT_FORMAT_MAP.get(ext)

        if not input_format:
            raise PandocConversionError(
                f"Unsupported file extension for Pandoc: {file_extension}"
            )

        # Create temporary files for input and output
        with tempfile.NamedTemporaryFile(
            suffix=file_extension, delete=False
        ) as input_file:
            input_file.write(content)
            input_path = input_file.name

        output_path = input_path + ".md"

        try:
            # Build Pandoc command
            cmd = [
                "pandoc",
                "-f",
                input_format,
                "-t",
                "markdown",
                input_path,
                "-o",
                output_path,
                "--wrap=none",  # Disable line wrapping for better splitting
            ]

            logger.debug(f"Running Pandoc command: {' '.join(cmd)}")

            # Execute Pandoc
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,  # 2 minute timeout
            )

            if result.returncode != 0:
                error_msg = result.stderr or result.stdout or "Unknown error"
                raise PandocConversionError(
                    f"Pandoc conversion failed (exit code {result.returncode}): {error_msg}"
                )

            # Read converted Markdown
            markdown_content = Path(output_path).read_text(encoding="utf-8")
            logger.info(
                f"Pandoc conversion successful: {len(content)} bytes -> "
                f"{len(markdown_content)} characters"
            )

            return markdown_content

        except subprocess.TimeoutExpired:
            raise PandocConversionError("Pandoc conversion timed out after 120 seconds")
        except FileNotFoundError:
            raise PandocConversionError(f"Pandoc output file not found: {output_path}")
        finally:
            # Clean up temporary files
            for path in [input_path, output_path]:
                try:
                    Path(path).unlink(missing_ok=True)
                except Exception as e:
                    logger.warning(f"Failed to delete temporary file {path}: {e}")

    def split(self, text_content: str) -> List[Document]:
        """
        Split Markdown content into Document chunks.

        Uses a two-pass splitting strategy optimized for Markdown:
        1. First pass: Split by Markdown structure (headers)
        2. Second pass: Apply sentence splitting for large sections

        Args:
            text_content: Markdown text content

        Returns:
            List of Document objects
        """
        if not text_content.strip():
            logger.warning("Empty text content received for splitting")
            return []

        # Create initial Document
        doc = Document(text=text_content)

        # First pass: Split by Markdown structure (headers)
        markdown_parser = MarkdownNodeParser()
        nodes = markdown_parser.get_nodes_from_documents([doc])

        # Second pass: Apply sentence splitting to large nodes
        sentence_splitter = SentenceSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )

        # Convert nodes back to documents for second pass
        intermediate_docs = [
            Document(
                text=node.text,
                metadata=node.metadata if hasattr(node, "metadata") else {},
            )
            for node in nodes
        ]

        final_nodes = sentence_splitter.get_nodes_from_documents(intermediate_docs)

        logger.info(f"Pandoc split created {len(final_nodes)} chunks")

        # Convert nodes to Documents
        return [
            Document(
                text=node.text,
                metadata=node.metadata if hasattr(node, "metadata") else {},
            )
            for node in final_nodes
        ]
