# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Fallback parser for unsupported file types.

Returns a single unsupported block for files that cannot be parsed.
"""

import logging
import uuid
from typing import List

from app.services.document_parser.base import BaseParser
from app.services.document_parser.factory import ParserFactory
from app.services.document_parser.models.block import BlockType, DocumentBlockData

logger = logging.getLogger(__name__)


class FallbackParser(BaseParser):
    """
    Fallback parser for unsupported file types.

    Creates a single unsupported block indicating the file format
    is not supported for preview.
    """

    def supported_content_types(self) -> List[str]:
        """Return empty list - this parser handles unmatched types."""
        return []

    def supported_extensions(self) -> List[str]:
        """Return empty list - this parser handles unmatched extensions."""
        return []

    def can_handle(self, content_type: str = None, filename: str = None) -> bool:
        """
        Always return False - this parser is only used as fallback.

        The ParserFactory explicitly uses this parser when no other
        parser matches.
        """
        return False

    def parse(
        self,
        binary_data: bytes,
        document_id: str,
        filename: str,
    ) -> List[DocumentBlockData]:
        """
        Create an unsupported block for unrecognized file types.

        Args:
            binary_data: Raw file content (unused)
            document_id: Document identifier
            filename: Original filename

        Returns:
            List containing a single unsupported DocumentBlockData block
        """
        logger.warning(f"Using fallback parser for unsupported file: {filename}")

        block = DocumentBlockData(
            id=str(uuid.uuid4()),
            document_id=document_id,
            block_type=BlockType.UNSUPPORTED,
            content=(
                "This file format is not supported for preview. "
                "Please download the original file to view."
            ),
            editable=False,
            order_index=0,
            source_ref=None,
            metadata={
                "filename": filename,
                "size_bytes": len(binary_data),
            },
        )

        return [block]
