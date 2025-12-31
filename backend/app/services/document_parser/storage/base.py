# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract storage service interface.

Defines the interface for storing extracted images during document parsing.
"""

from abc import ABC, abstractmethod
from typing import Optional


class BaseStorageService(ABC):
    """
    Abstract base class for storage services.

    Storage services handle saving and retrieving images extracted
    from documents during parsing.
    """

    @abstractmethod
    async def save_image(
        self,
        image_data: bytes,
        filename: str,
        document_id: str,
        content_type: Optional[str] = None,
    ) -> str:
        """
        Save image and return accessible URL.

        Args:
            image_data: Binary image data
            filename: Desired filename for the image
            document_id: ID of the document this image belongs to
            content_type: MIME type of the image

        Returns:
            URL or path to access the saved image
        """
        pass

    @abstractmethod
    async def delete_image(self, image_url: str) -> bool:
        """
        Delete image by URL.

        Args:
            image_url: URL or path of the image to delete

        Returns:
            True if deletion was successful, False otherwise
        """
        pass

    @abstractmethod
    async def delete_document_images(self, document_id: str) -> int:
        """
        Delete all images for a document.

        Args:
            document_id: ID of the document whose images should be deleted

        Returns:
            Number of images deleted
        """
        pass

    def save_image_sync(
        self,
        image_data: bytes,
        filename: str,
        document_id: str,
        content_type: Optional[str] = None,
    ) -> str:
        """
        Synchronous version of save_image for use in sync contexts.

        Args:
            image_data: Binary image data
            filename: Desired filename for the image
            document_id: ID of the document this image belongs to
            content_type: MIME type of the image

        Returns:
            URL or path to access the saved image
        """
        import asyncio

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # We're in an async context, create a new task
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(
                        asyncio.run,
                        self.save_image(image_data, filename, document_id, content_type),
                    )
                    return future.result()
            else:
                return loop.run_until_complete(
                    self.save_image(image_data, filename, document_id, content_type)
                )
        except RuntimeError:
            # No event loop, create one
            return asyncio.run(
                self.save_image(image_data, filename, document_id, content_type)
            )
