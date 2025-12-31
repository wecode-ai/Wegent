# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Image file parser.

Parses image files into structured blocks with OCR/description support.
"""

import logging
import uuid
from typing import List, Optional

from app.services.document_parser.base import BaseParser
from app.services.document_parser.factory import ParserFactory
from app.services.document_parser.models.block import BlockType, DocumentBlockData

logger = logging.getLogger(__name__)


@ParserFactory.register
class ImageParser(BaseParser):
    """
    Parser for image files.

    Creates a single image block with OCR text extraction and
    AI-generated description. Blocks are non-editable.
    """

    # Content type to extension mapping
    CONTENT_TYPE_MAP = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
        "image/webp": ".webp",
        "image/tiff": ".tiff",
        "image/x-icon": ".ico",
    }

    def supported_content_types(self) -> List[str]:
        """Return supported MIME types."""
        return list(self.CONTENT_TYPE_MAP.keys())

    def supported_extensions(self) -> List[str]:
        """Return supported file extensions."""
        return [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".ico"]

    def parse(
        self,
        binary_data: bytes,
        document_id: str,
        filename: str,
    ) -> List[DocumentBlockData]:
        """
        Parse image file into a single image block.

        Args:
            binary_data: Raw image file content
            document_id: Document identifier
            filename: Original filename

        Returns:
            List containing a single DocumentBlockData image block
        """
        logger.info(f"Parsing image file: {filename}")

        # Determine content type from filename
        ext = self._get_extension(filename)
        content_type = self._get_content_type(ext)

        # Save image to storage
        image_url = None
        if self.storage:
            try:
                image_url = self.storage.save_image_sync(
                    binary_data,
                    filename,
                    document_id,
                    content_type,
                )
            except Exception as e:
                logger.warning(f"Failed to save image: {e}")

        # Get OCR text and description
        ocr_text = None
        description = None

        if self.ocr:
            try:
                ocr_text = self.ocr.extract_text_sync(binary_data)
            except Exception as e:
                logger.warning(f"Failed to extract OCR text: {e}")

            try:
                description = self.ocr.describe_image_sync(binary_data)
            except Exception as e:
                logger.warning(f"Failed to generate image description: {e}")

        # Create image block
        block = DocumentBlockData(
            id=str(uuid.uuid4()),
            document_id=document_id,
            block_type=BlockType.IMAGE,
            content=description or "[Image - no description available]",
            editable=False,
            order_index=0,
            source_ref={"type": "full_image"},
            metadata={
                "image_url": image_url,
                "ocr_text": ocr_text,
                "filename": filename,
                "content_type": content_type,
                "size_bytes": len(binary_data),
            },
        )

        logger.info(f"Parsed image file into 1 block")
        return [block]

    def _get_content_type(self, ext: Optional[str]) -> str:
        """
        Get content type from file extension.

        Args:
            ext: File extension including dot

        Returns:
            MIME type string
        """
        if not ext:
            return "application/octet-stream"

        ext_lower = ext.lower()
        for content_type, file_ext in self.CONTENT_TYPE_MAP.items():
            if file_ext == ext_lower or (ext_lower == ".jpeg" and file_ext == ".jpg"):
                return content_type

        return "application/octet-stream"
