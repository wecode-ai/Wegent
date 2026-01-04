# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Parser factory for automatic parser selection.

The factory selects the appropriate parser based on content type
or file extension.
"""

import logging
from typing import Dict, List, Optional, Type

from app.services.document_parser.base import BaseParser
from app.services.document_parser.ocr.base import BaseOCRService
from app.services.document_parser.storage.base import BaseStorageService

logger = logging.getLogger(__name__)


class ParserFactory:
    """
    Factory for selecting appropriate parser based on content type or extension.

    Usage:
        factory = ParserFactory()
        parser = factory.get_parser(content_type="application/pdf")
        blocks = parser.parse(data, document_id, filename)
    """

    _parsers: List[Type[BaseParser]] = []

    def __init__(
        self,
        storage_service: Optional[BaseStorageService] = None,
        ocr_service: Optional[BaseOCRService] = None,
    ):
        """
        Initialize the factory with optional services.

        Args:
            storage_service: Service for storing extracted images
            ocr_service: Service for OCR and image description
        """
        self.storage_service = storage_service
        self.ocr_service = ocr_service
        self._ensure_parsers_registered()

    @classmethod
    def register(cls, parser_class: Type[BaseParser]) -> Type[BaseParser]:
        """
        Register a parser class with the factory.

        Can be used as a decorator:
            @ParserFactory.register
            class MyParser(BaseParser):
                ...

        Args:
            parser_class: Parser class to register

        Returns:
            The parser class (for decorator usage)
        """
        if parser_class not in cls._parsers:
            cls._parsers.append(parser_class)
            logger.debug(f"Registered parser: {parser_class.__name__}")
        return parser_class

    @classmethod
    def _ensure_parsers_registered(cls) -> None:
        """Ensure all parser classes are imported and registered."""
        # Import parsers to trigger registration via decorator
        from app.services.document_parser.parsers import (  # noqa: F401
            docx_parser,
            fallback_parser,
            image_parser,
            markdown_parser,
            pdf_parser,
        )

    def get_parser(
        self,
        content_type: Optional[str] = None,
        filename: Optional[str] = None,
    ) -> BaseParser:
        """
        Get appropriate parser based on content_type or filename extension.

        Priority: content_type > file extension > FallbackParser

        Args:
            content_type: MIME type of the document
            filename: Filename of the document

        Returns:
            Appropriate parser instance for the document type
        """
        # Try to find a matching parser
        for parser_class in self._parsers:
            parser = parser_class(
                storage_service=self.storage_service,
                ocr_service=self.ocr_service,
            )
            if parser.can_handle(content_type, filename):
                logger.info(
                    f"Selected parser {parser_class.__name__} for "
                    f"content_type={content_type}, filename={filename}"
                )
                return parser

        # Fall back to FallbackParser
        from app.services.document_parser.parsers.fallback_parser import FallbackParser

        logger.warning(
            f"No specific parser found for content_type={content_type}, "
            f"filename={filename}. Using FallbackParser."
        )
        return FallbackParser(
            storage_service=self.storage_service,
            ocr_service=self.ocr_service,
        )

    @classmethod
    def get_supported_content_types(cls) -> List[str]:
        """
        Get all supported content types from registered parsers.

        Returns:
            List of supported MIME types
        """
        cls._ensure_parsers_registered()
        content_types = []
        for parser_class in cls._parsers:
            parser = parser_class()
            content_types.extend(parser.supported_content_types())
        return list(set(content_types))

    @classmethod
    def get_supported_extensions(cls) -> List[str]:
        """
        Get all supported file extensions from registered parsers.

        Returns:
            List of supported file extensions
        """
        cls._ensure_parsers_registered()
        extensions = []
        for parser_class in cls._parsers:
            parser = parser_class()
            extensions.extend(parser.supported_extensions())
        return list(set(extensions))
