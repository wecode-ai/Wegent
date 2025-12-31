# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base parser abstract class.

All document parsers should inherit from BaseParser and implement
the required abstract methods.
"""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, List, Optional

if TYPE_CHECKING:
    from app.services.document_parser.models.block import DocumentBlockData
    from app.services.document_parser.ocr.base import BaseOCRService
    from app.services.document_parser.storage.base import BaseStorageService


class BaseParser(ABC):
    """
    Abstract base class for document parsers.

    All concrete parser implementations must inherit from this class
    and implement the required abstract methods.
    """

    def __init__(
        self,
        storage_service: Optional["BaseStorageService"] = None,
        ocr_service: Optional["BaseOCRService"] = None,
    ):
        """
        Initialize the parser with optional storage and OCR services.

        Args:
            storage_service: Service for storing extracted images
            ocr_service: Service for OCR and image description
        """
        self.storage = storage_service
        self.ocr = ocr_service

    @abstractmethod
    def parse(
        self,
        binary_data: bytes,
        document_id: str,
        filename: str,
    ) -> List["DocumentBlockData"]:
        """
        Parse binary document data into blocks.

        Args:
            binary_data: Raw binary content of the document
            document_id: Unique identifier for the document
            filename: Original filename of the document

        Returns:
            List of DocumentBlockData objects representing parsed content
        """
        pass

    @abstractmethod
    def supported_content_types(self) -> List[str]:
        """
        Return list of supported MIME types.

        Returns:
            List of MIME type strings this parser can handle
        """
        pass

    @abstractmethod
    def supported_extensions(self) -> List[str]:
        """
        Return list of supported file extensions.

        Returns:
            List of file extension strings (e.g., ['.md', '.markdown'])
        """
        pass

    def can_handle(self, content_type: Optional[str], filename: Optional[str]) -> bool:
        """
        Check if this parser can handle the given content type or filename.

        Args:
            content_type: MIME type of the document
            filename: Filename of the document

        Returns:
            True if this parser can handle the document
        """
        if content_type and content_type.lower() in [
            ct.lower() for ct in self.supported_content_types()
        ]:
            return True

        if filename:
            ext = self._get_extension(filename)
            if ext and ext.lower() in [e.lower() for e in self.supported_extensions()]:
                return True

        return False

    @staticmethod
    def _get_extension(filename: str) -> Optional[str]:
        """
        Extract file extension from filename.

        Args:
            filename: Filename to extract extension from

        Returns:
            File extension including the dot (e.g., '.pdf') or None
        """
        if not filename or "." not in filename:
            return None
        return "." + filename.rsplit(".", 1)[-1]
