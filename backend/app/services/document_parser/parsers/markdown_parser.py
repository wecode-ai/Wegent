# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Markdown document parser.

Parses Markdown files into structured blocks.
"""

import logging
import re
import uuid
from typing import List, Optional

from app.services.document_parser.base import BaseParser
from app.services.document_parser.factory import ParserFactory
from app.services.document_parser.models.block import BlockType, DocumentBlockData, SourceType

logger = logging.getLogger(__name__)


@ParserFactory.register
class MarkdownParser(BaseParser):
    """
    Parser for Markdown documents.

    Extracts headings, paragraphs, code blocks, lists, and tables
    from Markdown content. All text blocks are editable.
    """

    # Regex patterns for Markdown elements
    HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
    CODE_BLOCK_PATTERN = re.compile(r"```(\w*)\n([\s\S]*?)```", re.MULTILINE)
    TABLE_PATTERN = re.compile(
        r"(\|.+\|\n)+(\|[-:| ]+\|\n)(\|.+\|\n)*", re.MULTILINE
    )
    LIST_ITEM_PATTERN = re.compile(r"^(\s*[-*+]|\s*\d+\.)\s+.+$", re.MULTILINE)

    def supported_content_types(self) -> List[str]:
        """Return supported MIME types."""
        return ["text/markdown", "text/x-markdown"]

    def supported_extensions(self) -> List[str]:
        """Return supported file extensions."""
        return [".md", ".markdown", ".mdown", ".mkd"]

    def parse(
        self,
        binary_data: bytes,
        document_id: str,
        filename: str,
    ) -> List[DocumentBlockData]:
        """
        Parse Markdown content into blocks.

        Args:
            binary_data: Raw Markdown file content
            document_id: Document identifier
            filename: Original filename

        Returns:
            List of DocumentBlockData blocks
        """
        logger.info(f"Parsing Markdown document: {filename}")

        try:
            # Decode content
            content = binary_data.decode("utf-8")
        except UnicodeDecodeError:
            content = binary_data.decode("utf-8", errors="replace")

        blocks: List[DocumentBlockData] = []
        order_index = 0

        # Track positions of special elements to avoid double-processing
        processed_ranges: List[tuple] = []

        # Process code blocks first (they may contain # that looks like headings)
        for match in self.CODE_BLOCK_PATTERN.finditer(content):
            lang = match.group(1) or ""
            code = match.group(2).strip()
            start, end = match.span()
            processed_ranges.append((start, end))

            blocks.append(
                DocumentBlockData(
                    id=str(uuid.uuid4()),
                    document_id=document_id,
                    source_type=SourceType.MARKDOWN,
                    block_type=BlockType.CODE,
                    content=code,
                    editable=True,
                    order_index=order_index,
                    source_ref={"start": start, "end": end},
                    metadata={"lang": lang} if lang else None,
                )
            )
            order_index += 1

        # Process tables
        for match in self.TABLE_PATTERN.finditer(content):
            table_content = match.group(0).strip()
            start, end = match.span()
            if not self._is_in_range(start, processed_ranges):
                processed_ranges.append((start, end))
                blocks.append(
                    DocumentBlockData(
                        id=str(uuid.uuid4()),
                        document_id=document_id,
                        source_type=SourceType.MARKDOWN,
                        block_type=BlockType.TABLE,
                        content=table_content,
                        editable=True,
                        order_index=order_index,
                        source_ref={"start": start, "end": end},
                    )
                )
                order_index += 1

        # Process the content line by line for headings and paragraphs
        lines = content.split("\n")
        current_line_pos = 0
        current_paragraph: List[str] = []
        current_list: List[str] = []
        in_list = False

        for line_num, line in enumerate(lines):
            line_start = current_line_pos
            current_line_pos += len(line) + 1  # +1 for newline

            # Skip if this line is part of a processed range
            if self._is_in_range(line_start, processed_ranges):
                continue

            stripped = line.strip()

            # Check for heading
            heading_match = self.HEADING_PATTERN.match(line)
            if heading_match:
                # Flush current paragraph
                if current_paragraph:
                    blocks.append(self._create_paragraph_block(
                        current_paragraph, document_id, order_index, line_num - len(current_paragraph)
                    ))
                    order_index += 1
                    current_paragraph = []

                # Flush current list
                if current_list:
                    blocks.append(self._create_list_block(
                        current_list, document_id, order_index, line_num - len(current_list)
                    ))
                    order_index += 1
                    current_list = []
                    in_list = False

                level = len(heading_match.group(1))
                heading_text = heading_match.group(2).strip()

                blocks.append(
                    DocumentBlockData(
                        id=str(uuid.uuid4()),
                        document_id=document_id,
                        source_type=SourceType.MARKDOWN,
                        block_type=BlockType.HEADING,
                        content=heading_text,
                        editable=True,
                        order_index=order_index,
                        source_ref={"line": line_num + 1},
                        metadata={"level": level},
                    )
                )
                order_index += 1
                continue

            # Check for list item
            if self.LIST_ITEM_PATTERN.match(line):
                # Flush current paragraph
                if current_paragraph:
                    blocks.append(self._create_paragraph_block(
                        current_paragraph, document_id, order_index, line_num - len(current_paragraph)
                    ))
                    order_index += 1
                    current_paragraph = []

                current_list.append(line)
                in_list = True
                continue

            # If we were in a list and hit non-list content, flush the list
            if in_list and stripped and not self.LIST_ITEM_PATTERN.match(line):
                blocks.append(self._create_list_block(
                    current_list, document_id, order_index, line_num - len(current_list)
                ))
                order_index += 1
                current_list = []
                in_list = False

            # Empty line indicates paragraph break
            if not stripped:
                if current_paragraph:
                    blocks.append(self._create_paragraph_block(
                        current_paragraph, document_id, order_index, line_num - len(current_paragraph)
                    ))
                    order_index += 1
                    current_paragraph = []
                if current_list:
                    blocks.append(self._create_list_block(
                        current_list, document_id, order_index, line_num - len(current_list)
                    ))
                    order_index += 1
                    current_list = []
                    in_list = False
                continue

            # Regular text - add to current paragraph
            current_paragraph.append(line)

        # Flush remaining content
        if current_paragraph:
            blocks.append(self._create_paragraph_block(
                current_paragraph, document_id, order_index, len(lines) - len(current_paragraph)
            ))
            order_index += 1

        if current_list:
            blocks.append(self._create_list_block(
                current_list, document_id, order_index, len(lines) - len(current_list)
            ))

        # Sort blocks by their order_index (they may be out of order due to special element processing)
        # Actually, we should sort by source position for proper document order
        blocks.sort(key=lambda b: b.source_ref.get("line", 0) if b.source_ref else 0)

        # Re-assign order indices
        for idx, block in enumerate(blocks):
            block.order_index = idx

        logger.info(f"Parsed {len(blocks)} blocks from Markdown document")
        return blocks

    def _create_paragraph_block(
        self,
        lines: List[str],
        document_id: str,
        order_index: int,
        start_line: int,
    ) -> DocumentBlockData:
        """Create a paragraph block from lines."""
        return DocumentBlockData(
            id=str(uuid.uuid4()),
            document_id=document_id,
            source_type=SourceType.MARKDOWN,
            block_type=BlockType.PARAGRAPH,
            content="\n".join(lines),
            editable=True,
            order_index=order_index,
            source_ref={"line": start_line + 1},
        )

    def _create_list_block(
        self,
        lines: List[str],
        document_id: str,
        order_index: int,
        start_line: int,
    ) -> DocumentBlockData:
        """Create a list block from lines."""
        return DocumentBlockData(
            id=str(uuid.uuid4()),
            document_id=document_id,
            source_type=SourceType.MARKDOWN,
            block_type=BlockType.LIST,
            content="\n".join(lines),
            editable=True,
            order_index=order_index,
            source_ref={"line": start_line + 1},
        )

    @staticmethod
    def _is_in_range(pos: int, ranges: List[tuple]) -> bool:
        """Check if position is within any of the given ranges."""
        for start, end in ranges:
            if start <= pos < end:
                return True
        return False
