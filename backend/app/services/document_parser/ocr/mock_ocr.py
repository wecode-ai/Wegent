# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Mock OCR service implementation.

Provides placeholder responses for development and testing.
Implement actual OCR/vision API integration as needed.
"""

import logging

from app.services.document_parser.ocr.base import BaseOCRService

logger = logging.getLogger(__name__)


class MockOCRService(BaseOCRService):
    """
    Mock OCR service for development and testing.

    Returns placeholder text for OCR and image description.
    Replace with actual implementation using vision APIs like:
    - OpenAI GPT-4 Vision
    - Claude Vision
    - Google Cloud Vision
    - Azure Computer Vision
    - Tesseract OCR
    """

    async def extract_text(self, image_data: bytes) -> str:
        """
        Mock text extraction from image.

        Args:
            image_data: Binary image data

        Returns:
            Placeholder text indicating OCR is not implemented
        """
        logger.debug(f"Mock OCR: Processing {len(image_data)} bytes of image data")
        return "[OCR text extraction placeholder - implement with vision API]"

    async def describe_image(self, image_data: bytes) -> str:
        """
        Mock image description generation.

        Args:
            image_data: Binary image data

        Returns:
            Placeholder description indicating vision API is not implemented
        """
        logger.debug(
            f"Mock image description: Processing {len(image_data)} bytes of image data"
        )
        return "[Image description placeholder - implement with vision API]"
