# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local filesystem storage implementation.

Stores extracted images in the local filesystem, suitable for
development and single-server deployments.
"""

import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from app.services.document_parser.storage.base import BaseStorageService

logger = logging.getLogger(__name__)


class LocalStorageService(BaseStorageService):
    """
    Local filesystem storage service implementation.

    Stores images in a configurable directory structure:
    {base_path}/{document_id}/{filename}
    """

    def __init__(
        self,
        base_path: str = "uploads/document_images",
        url_prefix: str = "/api/document-images",
    ):
        """
        Initialize local storage service.

        Args:
            base_path: Base directory for storing images
            url_prefix: URL prefix for accessing images
        """
        self.base_path = Path(base_path)
        self.url_prefix = url_prefix

        # Ensure base directory exists
        self.base_path.mkdir(parents=True, exist_ok=True)

    async def save_image(
        self,
        image_data: bytes,
        filename: str,
        document_id: str,
        content_type: Optional[str] = None,
    ) -> str:
        """
        Save image to local filesystem.

        Args:
            image_data: Binary image data
            filename: Desired filename for the image
            document_id: ID of the document this image belongs to
            content_type: MIME type of the image (unused for local storage)

        Returns:
            URL path to access the saved image
        """
        # Create document directory
        doc_dir = self.base_path / document_id
        doc_dir.mkdir(parents=True, exist_ok=True)

        # Generate unique filename to avoid collisions
        base_name, ext = os.path.splitext(filename)
        unique_filename = f"{base_name}_{uuid.uuid4().hex[:8]}{ext}"
        file_path = doc_dir / unique_filename

        # Write image data
        try:
            with open(file_path, "wb") as f:
                f.write(image_data)

            logger.debug(f"Saved image to {file_path}")

            # Return URL path
            return f"{self.url_prefix}/{document_id}/{unique_filename}"

        except Exception as e:
            logger.error(f"Failed to save image: {e}")
            raise

    async def delete_image(self, image_url: str) -> bool:
        """
        Delete image by URL.

        Args:
            image_url: URL path of the image to delete

        Returns:
            True if deletion was successful, False otherwise
        """
        try:
            # Extract path from URL
            relative_path = image_url.replace(self.url_prefix, "").lstrip("/")
            file_path = self.base_path / relative_path

            if file_path.exists():
                file_path.unlink()
                logger.debug(f"Deleted image: {file_path}")
                return True
            else:
                logger.warning(f"Image not found: {file_path}")
                return False

        except Exception as e:
            logger.error(f"Failed to delete image: {e}")
            return False

    async def delete_document_images(self, document_id: str) -> int:
        """
        Delete all images for a document.

        Args:
            document_id: ID of the document whose images should be deleted

        Returns:
            Number of images deleted
        """
        doc_dir = self.base_path / document_id

        if not doc_dir.exists():
            return 0

        try:
            # Count files before deletion
            file_count = sum(1 for _ in doc_dir.iterdir() if _.is_file())

            # Remove entire directory
            shutil.rmtree(doc_dir)
            logger.debug(f"Deleted {file_count} images for document {document_id}")

            return file_count

        except Exception as e:
            logger.error(f"Failed to delete document images: {e}")
            return 0
