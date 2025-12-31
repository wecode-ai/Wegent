# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract OCR/vision service interface.

Defines the interface for OCR text extraction and image description.
"""

from abc import ABC, abstractmethod
from typing import Optional


class BaseOCRService(ABC):
    """
    Abstract base class for OCR and vision services.

    OCR services handle text extraction from images and AI-powered
    image description for accessibility and searchability.
    """

    @abstractmethod
    async def extract_text(self, image_data: bytes) -> str:
        """
        Extract text from image using OCR.

        Args:
            image_data: Binary image data

        Returns:
            Extracted text content
        """
        pass

    @abstractmethod
    async def describe_image(self, image_data: bytes) -> str:
        """
        Generate description of image using multimodal AI.

        Args:
            image_data: Binary image data

        Returns:
            Human-readable description of the image content
        """
        pass

    def extract_text_sync(self, image_data: bytes) -> str:
        """
        Synchronous version of extract_text for use in sync contexts.

        Args:
            image_data: Binary image data

        Returns:
            Extracted text content
        """
        import asyncio

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(
                        asyncio.run,
                        self.extract_text(image_data),
                    )
                    return future.result()
            else:
                return loop.run_until_complete(self.extract_text(image_data))
        except RuntimeError:
            return asyncio.run(self.extract_text(image_data))

    def describe_image_sync(self, image_data: bytes) -> str:
        """
        Synchronous version of describe_image for use in sync contexts.

        Args:
            image_data: Binary image data

        Returns:
            Human-readable description of the image content
        """
        import asyncio

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(
                        asyncio.run,
                        self.describe_image(image_data),
                    )
                    return future.result()
            else:
                return loop.run_until_complete(self.describe_image(image_data))
        except RuntimeError:
            return asyncio.run(self.describe_image(image_data))
