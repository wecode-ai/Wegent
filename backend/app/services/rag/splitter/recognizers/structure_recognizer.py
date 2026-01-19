# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Structure recognizer for identifying document elements.

This module implements Phase 2 of the document splitting pipeline:
converting raw text with line metadata into structured blocks (IR).
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from ..extractors.base import LineMetadata
from ..models.ir import BlockType, DocumentIR, StructureBlock
from .patterns import (
    BLOCKQUOTE_PATTERNS,
    CODE_BLOCK_PATTERNS,
    DEFINITION_PATTERNS,
    FLOW_PATTERNS,
    HEADING_PATTERNS,
    LIST_PATTERNS,
    QA_PATTERNS,
    TABLE_PATTERNS,
)

logger = logging.getLogger(__name__)


class StructureRecognizer:
    """
    Recognizes and classifies document structure elements.

    Transforms extracted text and line metadata into an Intermediate
    Representation (IR) consisting of typed structure blocks.
    """

    def __init__(self):
        """Initialize the structure recognizer."""
        self._heading_stack: List[Tuple[int, str]] = []  # Stack of (level, title)

    def recognize(
        self,
        text: str,
        line_metadata: List[LineMetadata],
        source_info: Optional[Dict[str, Any]] = None,
    ) -> DocumentIR:
        """
        Recognize structure in document text.

        Args:
            text: Document text content
            line_metadata: Line-by-line metadata from extractor
            source_info: Optional source file information

        Returns:
            DocumentIR containing recognized structure blocks
        """
        self._heading_stack = []
        blocks: List[StructureBlock] = []
        lines = text.split("\n")

        i = 0
        while i < len(lines):
            line = lines[i]
            meta = (
                line_metadata[i]
                if i < len(line_metadata)
                else LineMetadata(line_number=i + 1, original_line=line)
            )

            # Try to recognize multi-line structures first
            result = self._try_recognize_multiline(lines, line_metadata, i)
            if result:
                block, consumed = result
                blocks.append(block)
                i += consumed
                continue

            # Try single-line structures
            block = self._recognize_single_line(line, meta)
            if block:
                blocks.append(block)
            else:
                # Create paragraph block for unrecognized content
                if line.strip():
                    block = self._create_paragraph_block(line, meta)
                    blocks.append(block)

            i += 1

        # Merge consecutive paragraphs
        blocks = self._merge_consecutive_paragraphs(blocks)

        return DocumentIR(
            blocks=blocks,
            source_file=(
                source_info.get("filename", "unknown") if source_info else "unknown"
            ),
            file_type=source_info.get("file_type", "txt") if source_info else "txt",
            file_size=len(text),
            total_lines=len(lines),
            total_pages=source_info.get("total_pages") if source_info else None,
        )

    def _try_recognize_multiline(
        self,
        lines: List[str],
        metadata: List[LineMetadata],
        start_idx: int,
    ) -> Optional[Tuple[StructureBlock, int]]:
        """
        Try to recognize multi-line structures (code blocks, tables, lists).

        Returns:
            Tuple of (StructureBlock, lines_consumed) or None if not recognized
        """
        if start_idx >= len(lines):
            return None

        line = lines[start_idx]
        meta = (
            metadata[start_idx]
            if start_idx < len(metadata)
            else LineMetadata(line_number=start_idx + 1, original_line=line)
        )

        # Try code block
        result = self._try_code_block(lines, metadata, start_idx)
        if result:
            return result

        # Try table
        result = self._try_table(lines, metadata, start_idx)
        if result:
            return result

        # Try list
        result = self._try_list(lines, metadata, start_idx)
        if result:
            return result

        # Try Q&A
        result = self._try_qa(lines, metadata, start_idx)
        if result:
            return result

        return None

    def _try_code_block(
        self,
        lines: List[str],
        metadata: List[LineMetadata],
        start_idx: int,
    ) -> Optional[Tuple[StructureBlock, int]]:
        """Try to recognize a fenced code block."""
        line = lines[start_idx]

        # Check for fenced code block start
        fenced_match = CODE_BLOCK_PATTERNS["fenced_start"].match(line)
        if fenced_match:
            language = fenced_match.group(1) or None
            code_lines = [line]
            i = start_idx + 1

            while i < len(lines):
                code_lines.append(lines[i])
                if CODE_BLOCK_PATTERNS["fenced_end"].match(lines[i]):
                    break
                i += 1

            meta = (
                metadata[start_idx]
                if start_idx < len(metadata)
                else LineMetadata(line_number=start_idx + 1, original_line=line)
            )
            end_meta = (
                metadata[i]
                if i < len(metadata)
                else LineMetadata(
                    line_number=i + 1, original_line=lines[i] if i < len(lines) else ""
                )
            )

            block = StructureBlock(
                type=BlockType.CODE,
                content="\n".join(code_lines),
                language=language,
                line_start=meta.line_number,
                line_end=end_meta.line_number,
                page_number=meta.page_number,
                parent_headings=self._get_current_heading_path(),
            )
            return block, i - start_idx + 1

        return None

    def _try_table(
        self,
        lines: List[str],
        metadata: List[LineMetadata],
        start_idx: int,
    ) -> Optional[Tuple[StructureBlock, int]]:
        """Try to recognize a Markdown table."""
        line = lines[start_idx]

        # Check for Markdown table start
        if not TABLE_PATTERNS["markdown_row"].match(line):
            return None

        # Look for separator in next line
        if start_idx + 1 >= len(lines):
            return None

        next_line = lines[start_idx + 1]
        if not TABLE_PATTERNS["markdown_separator"].match(next_line):
            return None

        # Collect table rows
        table_lines = [line, next_line]
        i = start_idx + 2

        while i < len(lines):
            if TABLE_PATTERNS["markdown_row"].match(lines[i]):
                table_lines.append(lines[i])
                i += 1
            else:
                break

        # Parse table structure
        headers = self._parse_table_row(lines[start_idx])
        rows = [self._parse_table_row(row) for row in table_lines[2:]]

        meta = (
            metadata[start_idx]
            if start_idx < len(metadata)
            else LineMetadata(line_number=start_idx + 1, original_line=line)
        )
        end_idx = min(i - 1, len(lines) - 1)
        end_meta = (
            metadata[end_idx]
            if end_idx < len(metadata)
            else LineMetadata(line_number=end_idx + 1, original_line=lines[end_idx])
        )

        block = StructureBlock(
            type=BlockType.TABLE,
            content="\n".join(table_lines),
            headers=headers,
            rows=rows,
            line_start=meta.line_number,
            line_end=end_meta.line_number,
            page_number=meta.page_number,
            parent_headings=self._get_current_heading_path(),
        )
        return block, i - start_idx

    def _parse_table_row(self, row: str) -> List[str]:
        """Parse a Markdown table row into cells."""
        # Remove leading/trailing pipes and split
        cells = row.strip().strip("|").split("|")
        return [cell.strip() for cell in cells]

    def _try_list(
        self,
        lines: List[str],
        metadata: List[LineMetadata],
        start_idx: int,
    ) -> Optional[Tuple[StructureBlock, int]]:
        """Try to recognize a list structure."""
        line = lines[start_idx]

        # Check for list item
        list_type = None
        for pattern_name, pattern in LIST_PATTERNS.items():
            if pattern.match(line):
                list_type = (
                    "ordered"
                    if "numbered" in pattern_name or "letter" in pattern_name
                    else "unordered"
                )
                break

        if not list_type:
            return None

        # Collect list items
        list_lines = [line]
        items = [self._extract_list_item(line)]
        base_indent = self._get_indent_level(line)
        i = start_idx + 1

        while i < len(lines):
            current_line = lines[i]
            current_indent = self._get_indent_level(current_line)

            # Check if this is a list continuation
            is_list_item = False
            for pattern in LIST_PATTERNS.values():
                if pattern.match(current_line):
                    is_list_item = True
                    break

            # Empty lines within list are OK
            if not current_line.strip():
                # Check if next non-empty line is still part of list
                if i + 1 < len(lines):
                    next_non_empty = i + 1
                    while (
                        next_non_empty < len(lines)
                        and not lines[next_non_empty].strip()
                    ):
                        next_non_empty += 1
                    if next_non_empty < len(lines):
                        next_is_list = False
                        for pattern in LIST_PATTERNS.values():
                            if pattern.match(lines[next_non_empty]):
                                next_is_list = True
                                break
                        if not next_is_list:
                            break
                list_lines.append(current_line)
                i += 1
                continue

            # Continuation of previous item (indented more or no list marker)
            if current_indent > base_indent and not is_list_item:
                list_lines.append(current_line)
                # Append to last item
                if items:
                    items[-1] += " " + current_line.strip()
                i += 1
                continue

            # New list item at same or higher level
            if is_list_item and current_indent <= base_indent + 2:
                list_lines.append(current_line)
                items.append(self._extract_list_item(current_line))
                i += 1
                continue

            # End of list
            break

        meta = (
            metadata[start_idx]
            if start_idx < len(metadata)
            else LineMetadata(line_number=start_idx + 1, original_line=line)
        )
        end_idx = min(i - 1, len(lines) - 1)
        end_meta = (
            metadata[end_idx]
            if end_idx < len(metadata)
            else LineMetadata(line_number=end_idx + 1, original_line=lines[end_idx])
        )

        block = StructureBlock(
            type=BlockType.LIST,
            content="\n".join(list_lines),
            list_type=list_type,
            items=items,
            line_start=meta.line_number,
            line_end=end_meta.line_number,
            page_number=meta.page_number,
            parent_headings=self._get_current_heading_path(),
        )
        return block, i - start_idx

    def _extract_list_item(self, line: str) -> str:
        """Extract the content from a list item line."""
        for pattern in LIST_PATTERNS.values():
            match = pattern.match(line)
            if match:
                groups = match.groups()
                # Last group is usually the content
                return groups[-1] if groups else line.strip()
        return line.strip()

    def _get_indent_level(self, line: str) -> int:
        """Get indentation level of a line."""
        stripped = line.lstrip()
        if not stripped:
            return 0
        indent = len(line) - len(stripped)
        return indent // 2

    def _try_qa(
        self,
        lines: List[str],
        metadata: List[LineMetadata],
        start_idx: int,
    ) -> Optional[Tuple[StructureBlock, int]]:
        """Try to recognize a Q&A structure."""
        line = lines[start_idx]

        # Check for Q: pattern
        q_match = None
        for pattern_name in ["q_colon", "question_label"]:
            pattern = QA_PATTERNS.get(pattern_name)
            if pattern:
                q_match = pattern.match(line)
                if q_match:
                    break

        if not q_match:
            return None

        question = q_match.group(1).strip()
        qa_lines = [line]
        answer_lines = []
        i = start_idx + 1

        # Look for answer
        in_answer = False
        while i < len(lines):
            current_line = lines[i]

            # Check for A: pattern
            a_match = None
            for pattern_name in ["a_colon", "answer_label"]:
                pattern = QA_PATTERNS.get(pattern_name)
                if pattern:
                    a_match = pattern.match(current_line)
                    if a_match:
                        in_answer = True
                        qa_lines.append(current_line)
                        answer_lines.append(a_match.group(1).strip())
                        i += 1
                        continue

            # Check for next question (end of this Q&A)
            next_q = None
            for pattern_name in ["q_colon", "question_label"]:
                pattern = QA_PATTERNS.get(pattern_name)
                if pattern:
                    next_q = pattern.match(current_line)
                    if next_q:
                        break
            if next_q:
                break

            # Empty line might end Q&A
            if not current_line.strip():
                if in_answer:
                    # Check if there's more answer content
                    if i + 1 < len(lines) and lines[i + 1].strip():
                        # Check if next is a new Q
                        next_is_q = False
                        for pattern_name in ["q_colon", "question_label"]:
                            pattern = QA_PATTERNS.get(pattern_name)
                            if pattern and pattern.match(lines[i + 1]):
                                next_is_q = True
                                break
                        if next_is_q:
                            break
                qa_lines.append(current_line)
                i += 1
                continue

            # Continue collecting answer
            if in_answer:
                qa_lines.append(current_line)
                answer_lines.append(current_line.strip())
            i += 1

        # Only create Q&A block if we found an answer
        if not answer_lines:
            return None

        meta = (
            metadata[start_idx]
            if start_idx < len(metadata)
            else LineMetadata(line_number=start_idx + 1, original_line=line)
        )
        end_idx = min(i - 1, len(lines) - 1)
        end_meta = (
            metadata[end_idx]
            if end_idx < len(metadata)
            else LineMetadata(line_number=end_idx + 1, original_line=lines[end_idx])
        )

        block = StructureBlock(
            type=BlockType.QA,
            content="\n".join(qa_lines),
            question=question,
            answer=" ".join(answer_lines),
            line_start=meta.line_number,
            line_end=end_meta.line_number,
            page_number=meta.page_number,
            parent_headings=self._get_current_heading_path(),
        )
        return block, i - start_idx

    def _recognize_single_line(
        self,
        line: str,
        meta: LineMetadata,
    ) -> Optional[StructureBlock]:
        """Recognize single-line structures."""
        stripped = line.strip()
        if not stripped:
            return None

        # Heading (from metadata or pattern)
        if meta.is_heading:
            return self._create_heading_block(line, meta)

        # Check heading patterns
        for pattern_name, pattern in HEADING_PATTERNS.items():
            if pattern_name in ["setext_h1", "setext_h2"]:
                continue  # These need two lines
            match = pattern.match(stripped)
            if match:
                level = 1
                if pattern_name == "markdown_atx":
                    level = len(match.group(1))
                elif pattern_name == "numbered":
                    level = match.group(1).count(".") + 1
                block = self._create_heading_block(line, meta, level)
                return block

        # Blockquote
        blockquote_match = BLOCKQUOTE_PATTERNS["markdown"].match(line)
        if blockquote_match:
            return StructureBlock(
                type=BlockType.BLOCKQUOTE,
                content=blockquote_match.group(2),
                line_start=meta.line_number,
                line_end=meta.line_number,
                page_number=meta.page_number,
                parent_headings=self._get_current_heading_path(),
            )

        # Flow/conditional
        for pattern_name, pattern in FLOW_PATTERNS.items():
            match = pattern.match(stripped)
            if match:
                groups = match.groups()
                condition = groups[0] if groups else None
                result = groups[1] if len(groups) > 1 else None
                return StructureBlock(
                    type=BlockType.FLOW,
                    content=stripped,
                    line_start=meta.line_number,
                    line_end=meta.line_number,
                    page_number=meta.page_number,
                    parent_headings=self._get_current_heading_path(),
                    metadata={"condition": condition, "result": result},
                )

        # Definition
        for pattern_name, pattern in DEFINITION_PATTERNS.items():
            match = pattern.match(stripped)
            if match:
                return StructureBlock(
                    type=BlockType.DEFINITION,
                    content=stripped,
                    line_start=meta.line_number,
                    line_end=meta.line_number,
                    page_number=meta.page_number,
                    parent_headings=self._get_current_heading_path(),
                )

        return None

    def _create_heading_block(
        self,
        line: str,
        meta: LineMetadata,
        level: Optional[int] = None,
    ) -> StructureBlock:
        """Create a heading block and update heading stack."""
        heading_level = level or meta.heading_level or 1

        # Extract heading text
        text = line.strip()
        # Remove markdown # markers
        atx_match = re.match(r"^#{1,6}\s+(.+)$", text)
        if atx_match:
            text = atx_match.group(1)

        # Update heading stack
        while self._heading_stack and self._heading_stack[-1][0] >= heading_level:
            self._heading_stack.pop()
        self._heading_stack.append((heading_level, text))

        return StructureBlock(
            type=BlockType.HEADING,
            content=line.strip(),
            level=heading_level,
            line_start=meta.line_number,
            line_end=meta.line_number,
            page_number=meta.page_number,
            parent_headings=self._get_current_heading_path()[:-1],  # Exclude self
        )

    def _create_paragraph_block(
        self,
        line: str,
        meta: LineMetadata,
    ) -> StructureBlock:
        """Create a paragraph block."""
        return StructureBlock(
            type=BlockType.PARAGRAPH,
            content=line,
            line_start=meta.line_number,
            line_end=meta.line_number,
            page_number=meta.page_number,
            parent_headings=self._get_current_heading_path(),
        )

    def _get_current_heading_path(self) -> List[str]:
        """Get the current heading path as a list of titles."""
        return [title for _, title in self._heading_stack]

    def _merge_consecutive_paragraphs(
        self,
        blocks: List[StructureBlock],
    ) -> List[StructureBlock]:
        """Merge consecutive paragraph blocks."""
        if not blocks:
            return blocks

        merged: List[StructureBlock] = []

        for block in blocks:
            if (
                block.type == BlockType.PARAGRAPH
                and merged
                and merged[-1].type == BlockType.PARAGRAPH
                and merged[-1].parent_headings == block.parent_headings
                and block.line_start == merged[-1].line_end + 1
            ):
                # Merge with previous paragraph
                merged[-1].content += "\n" + block.content
                merged[-1].line_end = block.line_end
            else:
                merged.append(block)

        return merged
