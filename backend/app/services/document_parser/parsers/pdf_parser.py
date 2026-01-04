# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
PDF document parser.

Parses PDF files into structured blocks using PyMuPDF.
"""

import io
import logging
import uuid
from typing import List, Optional

from app.services.document_parser.base import BaseParser
from app.services.document_parser.factory import ParserFactory
from app.services.document_parser.models.block import BlockType, DocumentBlockData, SourceType

logger = logging.getLogger(__name__)


@ParserFactory.register
class PDFParser(BaseParser):
    """
    Parser for PDF documents.

    Uses PyMuPDF (fitz) to extract text blocks and images.
    Text blocks are non-editable; images are processed through OCR service.
    """

    def supported_content_types(self) -> List[str]:
        """Return supported MIME types."""
        return ["application/pdf"]

    def supported_extensions(self) -> List[str]:
        """Return supported file extensions."""
        return [".pdf"]

    def parse(
        self,
        binary_data: bytes,
        document_id: str,
        filename: str,
    ) -> List[DocumentBlockData]:
        """
        Parse PDF content into blocks.

        Args:
            binary_data: Raw PDF file content
            document_id: Document identifier
            filename: Original filename

        Returns:
            List of DocumentBlockData blocks
        """
        logger.info(f"Parsing PDF document: {filename}")

        try:
            import fitz  # PyMuPDF
        except ImportError:
            logger.error("PyMuPDF not installed. Install with: pip install PyMuPDF")
            return [
                DocumentBlockData(
                    id=str(uuid.uuid4()),
                    document_id=document_id,
                    source_type=SourceType.PDF,
                    block_type=BlockType.UNSUPPORTED,
                    content="PDF parsing requires PyMuPDF library. Please install it with: pip install PyMuPDF",
                    editable=False,
                    order_index=0,
                )
            ]

        blocks: List[DocumentBlockData] = []
        order_index = 0

        try:
            # Open PDF from bytes
            doc = fitz.open(stream=binary_data, filetype="pdf")

            for page_num in range(len(doc)):
                page = doc[page_num]

                # Extract text blocks
                text_blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)

                for block in text_blocks.get("blocks", []):
                    if block["type"] == 0:  # Text block
                        text_content = self._extract_text_from_block(block)
                        if text_content.strip():
                            # Determine if this looks like a heading
                            block_type, metadata = self._classify_text_block(block, text_content)

                            blocks.append(
                                DocumentBlockData(
                                    id=str(uuid.uuid4()),
                                    document_id=document_id,
                                    source_type=SourceType.PDF,
                                    block_type=block_type,
                                    content=text_content.strip(),
                                    editable=False,
                                    order_index=order_index,
                                    source_ref={
                                        "page": page_num + 1,
                                        "bbox": list(block.get("bbox", [])),
                                    },
                                    metadata=metadata,
                                )
                            )
                            order_index += 1

                    elif block["type"] == 1:  # Image block
                        image_data = self._extract_image(page, block)
                        if image_data:
                            # Save image and get URL
                            image_url = None
                            if self.storage:
                                image_filename = f"page{page_num + 1}_img{order_index}.png"
                                try:
                                    image_url = self.storage.save_image_sync(
                                        image_data,
                                        image_filename,
                                        document_id,
                                        "image/png",
                                    )
                                except Exception as e:
                                    logger.warning(f"Failed to save image: {e}")

                            # Get image description from OCR service
                            description = None
                            ocr_text = None
                            if self.ocr:
                                try:
                                    description = self.ocr.describe_image_sync(image_data)
                                    ocr_text = self.ocr.extract_text_sync(image_data)
                                except Exception as e:
                                    logger.warning(f"Failed to process image with OCR: {e}")

                            blocks.append(
                                DocumentBlockData(
                                    id=str(uuid.uuid4()),
                                    document_id=document_id,
                                    source_type=SourceType.PDF,
                                    block_type=BlockType.IMAGE,
                                    content=description or "[Image - no description available]",
                                    editable=False,
                                    order_index=order_index,
                                    source_ref={
                                        "page": page_num + 1,
                                        "bbox": list(block.get("bbox", [])),
                                    },
                                    metadata={
                                        "image_url": image_url,
                                        "ocr_text": ocr_text,
                                    },
                                )
                            )
                            order_index += 1

            doc.close()
            logger.info(f"Parsed {len(blocks)} blocks from PDF document")

        except Exception as e:
            logger.error(f"Error parsing PDF: {e}")
            blocks.append(
                DocumentBlockData(
                    id=str(uuid.uuid4()),
                    document_id=document_id,
                    source_type=SourceType.PDF,
                    block_type=BlockType.UNSUPPORTED,
                    content=f"Error parsing PDF: {str(e)}",
                    editable=False,
                    order_index=0,
                )
            )

        return blocks

    def _extract_text_from_block(self, block: dict) -> str:
        """
        Extract text content from a PDF text block.

        Args:
            block: PyMuPDF block dictionary

        Returns:
            Concatenated text content
        """
        lines = []
        for line in block.get("lines", []):
            line_text = ""
            for span in line.get("spans", []):
                line_text += span.get("text", "")
            lines.append(line_text)
        return "\n".join(lines)

    def _classify_text_block(
        self,
        block: dict,
        text: str,
    ) -> tuple:
        """
        Classify a text block as heading or paragraph.

        Uses font size and style to determine block type.

        Args:
            block: PyMuPDF block dictionary
            text: Extracted text content

        Returns:
            Tuple of (BlockType, metadata dict)
        """
        # Get average font size from spans
        font_sizes = []
        is_bold = False

        for line in block.get("lines", []):
            for span in line.get("spans", []):
                font_sizes.append(span.get("size", 12))
                flags = span.get("flags", 0)
                if flags & 16:  # Bold flag
                    is_bold = True

        avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 12

        # Heuristics for heading detection
        # Large font or bold with short text likely a heading
        is_short = len(text) < 100 and "\n" not in text.strip()

        if avg_font_size >= 14 and is_short:
            # Determine heading level based on font size
            if avg_font_size >= 24:
                level = 1
            elif avg_font_size >= 18:
                level = 2
            elif avg_font_size >= 14:
                level = 3
            else:
                level = 4
            return BlockType.HEADING, {"level": level, "font_size": avg_font_size}

        return BlockType.PARAGRAPH, {"font_size": avg_font_size}

    def _extract_image(self, page, block: dict) -> Optional[bytes]:
        """
        Extract image data from a PDF page block.

        Args:
            page: PyMuPDF page object
            block: Block dictionary containing image reference

        Returns:
            Image data as bytes or None
        """
        try:
            import fitz

            # Get the image from the page
            xref = block.get("image", 0)
            if xref:
                base_image = page.parent.extract_image(xref)
                if base_image:
                    return base_image.get("image")

            # Fallback: try to get image from bbox
            bbox = block.get("bbox")
            if bbox:
                clip = fitz.Rect(bbox)
                pix = page.get_pixmap(clip=clip)
                return pix.tobytes("png")

        except Exception as e:
            logger.warning(f"Failed to extract image: {e}")

        return None
