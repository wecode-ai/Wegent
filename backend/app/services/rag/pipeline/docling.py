# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Docling document processing pipeline.

This pipeline uses the Docling API service to convert documents
(DOC, DOCX, PPT, PPTX, PDF) to Markdown with advanced layout
understanding and structure preservation.
"""

import logging
from typing import List, Optional

import httpx
from llama_index.core import Document
from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter

from app.services.rag.pipeline.base import BaseDocumentPipeline

logger = logging.getLogger(__name__)


class DoclingServiceError(Exception):
    """Raised when Docling API service call fails."""

    pass


class DoclingPipeline(BaseDocumentPipeline):
    """
    Document pipeline using Docling API for advanced document conversion.

    Docling provides superior document understanding with:
    - Advanced layout analysis
    - Table extraction
    - Figure detection
    - Structure preservation

    The service converts documents to Markdown format with OCR disabled
    (as per requirements) for faster processing.

    Suitable for:
    - DOC/DOCX files (Word documents)
    - PPT/PPTX files (PowerPoint presentations)
    - PDF files (when Docling is configured)

    Configuration:
    - DOCLING_URL: Docling service endpoint
    - DOCLING_TIMEOUT: Request timeout in seconds (default: 120)
    """

    # File extensions handled by this pipeline
    SUPPORTED_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx", ".pdf"}

    # Content type mapping for file upload
    CONTENT_TYPE_MAP = {
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".pdf": "application/pdf",
    }

    def __init__(
        self,
        docling_url: str,
        chunk_size: int = BaseDocumentPipeline.DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = BaseDocumentPipeline.DEFAULT_CHUNK_OVERLAP,
        timeout: int = 120,
    ):
        """
        Initialize Docling pipeline.

        Args:
            docling_url: Docling service URL endpoint
            chunk_size: Maximum chunk size in characters
            chunk_overlap: Number of characters to overlap between chunks
            timeout: HTTP request timeout in seconds

        Raises:
            ValueError: If docling_url is empty
        """
        super().__init__(chunk_size, chunk_overlap)

        if not docling_url:
            raise ValueError("Docling URL is required")

        self.docling_url = docling_url.rstrip("/")
        self.timeout = timeout

    @classmethod
    def get_supported_extensions(cls) -> set:
        """Get supported file extensions."""
        return cls.SUPPORTED_EXTENSIONS

    @classmethod
    def is_service_available(cls, docling_url: str, timeout: int = 10) -> bool:
        """
        Check if Docling service is available.

        Args:
            docling_url: Docling service URL
            timeout: Connection timeout in seconds

        Returns:
            True if service is reachable
        """
        if not docling_url:
            return False

        try:
            # Try to reach the service health endpoint
            with httpx.Client(timeout=timeout) as client:
                # Try common health check endpoints
                for endpoint in ["/health", "/api/health", "/"]:
                    try:
                        response = client.get(f"{docling_url.rstrip('/')}{endpoint}")
                        if response.status_code < 500:
                            return True
                    except Exception:
                        continue
                return False
        except Exception as e:
            logger.debug(f"Docling service health check failed: {e}")
            return False

    def read(self, binary_data: bytes, file_extension: str) -> bytes:
        """
        Pass through binary data.

        Docling conversion happens in the convert stage.

        Args:
            binary_data: Raw binary file content
            file_extension: File extension

        Returns:
            Unchanged binary data
        """
        return binary_data

    def convert(self, content: bytes, file_extension: str) -> str:
        """
        Convert document to Markdown using Docling API.

        Sends the document to Docling service for conversion with
        OCR disabled for faster processing.

        API Request:
        - Method: POST
        - Content: multipart/form-data with file
        - Parameters: output_format=markdown, ocr_enabled=false

        API Response:
        ```json
        {
            "document": {
                "md_content": "Markdown content here..."
            }
        }
        ```

        Args:
            content: Binary file content
            file_extension: File extension for MIME type detection

        Returns:
            Markdown text content

        Raises:
            DoclingServiceError: If API call fails
        """
        ext = file_extension.lower()
        content_type = self.CONTENT_TYPE_MAP.get(ext, "application/octet-stream")

        # Prepare file for upload
        filename = f"document{ext}"
        files = {"file": (filename, content, content_type)}

        # Request parameters - disable OCR for faster processing
        params = {
            "output_format": "markdown",
            "ocr_enabled": "false",
        }

        try:
            logger.info(
                f"Calling Docling API: url={self.docling_url}, "
                f"file_size={len(content)}, extension={ext}"
            )

            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.docling_url}/convert",
                    files=files,
                    params=params,
                )

                if response.status_code != 200:
                    error_detail = (
                        response.text[:500] if response.text else "No details"
                    )
                    raise DoclingServiceError(
                        f"Docling API returned status {response.status_code}: {error_detail}"
                    )

                result = response.json()

                # Extract Markdown content from response
                md_content = self._extract_markdown(result)

                if not md_content:
                    raise DoclingServiceError(
                        "Docling API returned empty Markdown content"
                    )

                logger.info(
                    f"Docling conversion successful: {len(content)} bytes -> "
                    f"{len(md_content)} characters"
                )

                return md_content

        except httpx.TimeoutException:
            raise DoclingServiceError(
                f"Docling API request timed out after {self.timeout} seconds"
            )
        except httpx.ConnectError as e:
            raise DoclingServiceError(
                f"Failed to connect to Docling service at {self.docling_url}: {e}"
            )
        except httpx.HTTPError as e:
            raise DoclingServiceError(f"HTTP error during Docling conversion: {e}")

    def _extract_markdown(self, response: dict) -> Optional[str]:
        """
        Extract Markdown content from Docling API response.

        Handles various response formats that Docling might return.

        Args:
            response: JSON response from Docling API

        Returns:
            Markdown content string or None
        """
        # Primary format: {"document": {"md_content": "..."}}
        if isinstance(response, dict):
            document = response.get("document", {})
            if isinstance(document, dict):
                md_content = document.get("md_content")
                if md_content:
                    return md_content

            # Alternative format: {"md_content": "..."}
            md_content = response.get("md_content")
            if md_content:
                return md_content

            # Another alternative: {"content": "..."}
            content = response.get("content")
            if content:
                return content

            # Direct markdown in response: {"markdown": "..."}
            markdown = response.get("markdown")
            if markdown:
                return markdown

        return None

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

        logger.info(f"Docling split created {len(final_nodes)} chunks")

        # Convert nodes to Documents
        return [
            Document(
                text=node.text,
                metadata=node.metadata if hasattr(node, "metadata") else {},
            )
            for node in final_nodes
        ]
