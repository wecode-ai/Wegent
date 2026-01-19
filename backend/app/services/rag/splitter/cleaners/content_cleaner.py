# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Content cleaner for document processing.

This module implements Phase 6 of the document splitting pipeline:
cleaning and normalizing content based on chunk type.
"""

import logging
import re
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# Special characters to remove
REMOVE_CHARS = {
    "\x00",
    "\x01",
    "\x02",
    "\x03",
    "\x04",
    "\x05",
    "\x06",
    "\x07",  # ASCII control
    "\x08",
    "\x0b",
    "\x0c",
    "\x0e",
    "\x0f",  # More control chars
    "\x10",
    "\x11",
    "\x12",
    "\x13",
    "\x14",
    "\x15",
    "\x16",
    "\x17",
    "\x18",
    "\x19",
    "\x1a",
    "\x1b",
    "\x1c",
    "\x1d",
    "\x1e",
    "\x1f",
    "\x7f",  # DEL
    "\u200b",  # Zero-width space
    "\u200c",  # Zero-width non-joiner
    "\u200d",  # Zero-width joiner
    "\ufeff",  # BOM
    "\u00a0",  # Non-breaking space (convert to regular space)
}

# Replacement map for special characters
REPLACEMENT_MAP = {
    "\u00a0": " ",  # Non-breaking space to space
    "\u2018": "'",  # Left single quote
    "\u2019": "'",  # Right single quote
    "\u201c": '"',  # Left double quote
    "\u201d": '"',  # Right double quote
    "\u2013": "-",  # En dash
    "\u2014": "-",  # Em dash
    "\u2026": "...",  # Ellipsis
}


class ContentCleaner:
    """
    Cleans and normalizes chunk content based on type.

    Cleaning rules:
    - paragraph/blockquote/definition: Merge lines, compress whitespace
    - list: Normalize bullets, clean item text
    - qa: Normalize Q:/A: markers
    - code: Preserve formatting, remove extra blank lines
    - table: Normalize separators, clean cells
    - flow: Normalize arrows
    - heading: Clean text, remove trailing punctuation
    """

    def __init__(self):
        """Initialize the content cleaner."""
        pass

    def clean(self, chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Clean all chunks based on their types.

        Args:
            chunks: List of chunk dictionaries

        Returns:
            List of cleaned chunk dictionaries
        """
        cleaned_chunks = []

        for chunk in chunks:
            cleaned_chunk = self._clean_chunk(chunk)
            cleaned_chunks.append(cleaned_chunk)

        return cleaned_chunks

    def _clean_chunk(self, chunk: Dict[str, Any]) -> Dict[str, Any]:
        """Clean a single chunk based on its type."""
        chunk_type = chunk.get("chunk_type", "paragraph")
        content = chunk.get("content", "")

        # Apply base cleaning
        content = self._remove_special_characters(content)

        # Apply type-specific cleaning
        if chunk_type == "code":
            content = self._clean_code(content)
        elif chunk_type == "table":
            content = self._clean_table(content)
        elif chunk_type == "list":
            content = self._clean_list(content)
        elif chunk_type == "qa":
            content = self._clean_qa(content)
        elif chunk_type == "flow":
            content = self._clean_flow(content)
        elif chunk_type == "heading":
            content = self._clean_heading(content)
        elif chunk_type == "blockquote":
            content = self._clean_blockquote(content)
        elif chunk_type == "definition":
            content = self._clean_definition(content)
        else:  # paragraph and others
            content = self._clean_paragraph(content)

        # Create cleaned chunk
        cleaned = chunk.copy()
        cleaned["content"] = content

        return cleaned

    def _remove_special_characters(self, text: str) -> str:
        """Remove or replace special characters."""
        result = []
        for char in text:
            if char in REMOVE_CHARS:
                continue
            if char in REPLACEMENT_MAP:
                result.append(REPLACEMENT_MAP[char])
            else:
                result.append(char)
        return "".join(result)

    def _clean_paragraph(self, content: str) -> str:
        """Clean paragraph content - compact, remove excess whitespace."""
        # Replace single newlines with spaces (preserve paragraph breaks)
        content = re.sub(r"(?<!\n)\n(?!\n)", " ", content)

        # Compress multiple spaces to single
        content = re.sub(r"[ \t]+", " ", content)

        # Remove separator lines (---, ***, etc.)
        content = re.sub(r"^\s*[-*_=]{3,}\s*$", "", content, flags=re.MULTILINE)

        # Normalize paragraph breaks
        content = re.sub(r"\n{3,}", "\n\n", content)

        # Clean up line beginnings and endings
        lines = content.split("\n")
        cleaned_lines = [line.strip() for line in lines]
        content = "\n".join(cleaned_lines)

        return content.strip()

    def _clean_code(self, content: str) -> str:
        """Clean code content - preserve formatting, remove extra blank lines."""
        lines = content.split("\n")
        cleaned_lines = []

        consecutive_empty = 0
        for line in lines:
            # Remove trailing whitespace but preserve leading (indentation)
            line = line.rstrip()

            # Track consecutive empty lines
            if not line.strip():
                consecutive_empty += 1
                if consecutive_empty <= 1:  # Allow max 1 consecutive empty line
                    cleaned_lines.append(line)
            else:
                consecutive_empty = 0
                cleaned_lines.append(line)

        # Remove leading/trailing empty lines
        while cleaned_lines and not cleaned_lines[0].strip():
            cleaned_lines.pop(0)
        while cleaned_lines and not cleaned_lines[-1].strip():
            cleaned_lines.pop()

        return "\n".join(cleaned_lines)

    def _clean_table(self, content: str) -> str:
        """Clean table content - normalize structure."""
        lines = content.split("\n")
        cleaned_lines = []

        for line in lines:
            if not line.strip():
                continue

            # Check if it's a table row
            if "|" in line:
                # Normalize cell spacing
                cells = line.split("|")
                normalized_cells = [cell.strip() for cell in cells]
                line = " | ".join(normalized_cells)

                # Clean up leading/trailing pipes
                if line.startswith(" | "):
                    line = "|" + line[2:]
                if line.endswith(" | "):
                    line = line[:-2] + "|"

            cleaned_lines.append(line)

        return "\n".join(cleaned_lines)

    def _clean_list(self, content: str) -> str:
        """Clean list content - normalize bullets, clean items."""
        lines = content.split("\n")
        cleaned_lines = []

        for line in lines:
            stripped = line.strip()
            if not stripped:
                cleaned_lines.append("")
                continue

            # Normalize unordered bullets to -
            stripped = re.sub(r"^[*+]\s", "- ", stripped)

            # Normalize ordered numbers
            stripped = re.sub(r"^(\d+)\)\s", r"\1. ", stripped)

            # Clean item text
            stripped = re.sub(r"\s+", " ", stripped)

            cleaned_lines.append(stripped)

        return "\n".join(cleaned_lines)

    def _clean_qa(self, content: str) -> str:
        """Clean Q&A content - normalize Q:/A: markers."""
        # Normalize question markers
        content = re.sub(r"^[Qq问][:：]\s*", "Q: ", content, flags=re.MULTILINE)

        # Normalize answer markers
        content = re.sub(r"^[Aa答][:：]\s*", "A: ", content, flags=re.MULTILINE)

        # Clean up multiple newlines
        content = re.sub(r"\n{3,}", "\n\n", content)

        return content.strip()

    def _clean_flow(self, content: str) -> str:
        """Clean flow/conditional content - normalize arrows."""
        # Normalize arrows
        content = re.sub(r"\s*[-=]+>\s*", " -> ", content)
        content = re.sub(r"\s*[→⇒]\s*", " -> ", content)

        # Clean whitespace
        content = re.sub(r"[ \t]+", " ", content)

        return content.strip()

    def _clean_heading(self, content: str) -> str:
        """Clean heading content."""
        content = content.strip()

        # Keep markdown # markers
        # Remove trailing punctuation (except for questions)
        if not content.endswith("?"):
            content = re.sub(r"[:：\s]+$", "", content)

        # Compress whitespace
        content = re.sub(r"[ \t]+", " ", content)

        return content

    def _clean_blockquote(self, content: str) -> str:
        """Clean blockquote content."""
        lines = content.split("\n")
        cleaned_lines = []

        for line in lines:
            # Preserve > markers but normalize spacing
            if line.strip().startswith(">"):
                # Normalize > spacing
                line = re.sub(r"^(\s*>+)\s*", r"\1 ", line)
            cleaned_lines.append(line.strip())

        return "\n".join(cleaned_lines)

    def _clean_definition(self, content: str) -> str:
        """Clean definition content."""
        # Apply paragraph cleaning
        content = self._clean_paragraph(content)

        # Normalize definition separators
        content = re.sub(r"[:：]\s+", ": ", content)

        return content
