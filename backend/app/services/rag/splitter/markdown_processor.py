# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Markdown intelligent chunking processor.

This module provides enhanced markdown processing with:
1. Preprocessing: Table protection, noise removal, code block protection
2. Header-based splitting: Split by H1-H3 headers
3. Chunk merging: Merge small chunks below threshold
4. Chunk splitting: Split large chunks (except code blocks and tables)
5. Context injection: Add document title and header hierarchy prefix

Processing flow:
    Preprocess → Split by Headers → Merge Small → Split Large → Inject Context
"""

import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
from llama_index.core import Document

logger = logging.getLogger(__name__)


@dataclass
class ChunkWithContext:
    """Chunk with context information for processing."""

    content: str
    header_hierarchy: List[str] = field(default_factory=list)
    header_level: int = 0  # 0 means no header, 1-3 for H1-H3
    is_code_block: bool = False
    is_table: bool = False

    def __len__(self) -> int:
        return len(self.content)


class MarkdownProcessor:
    """
    Markdown intelligent chunking processor.

    Provides enhanced markdown processing with preprocessing, header-based splitting,
    chunk merging/splitting, and context prefix injection.

    Example usage:
        processor = MarkdownProcessor(chunk_size=1024, chunk_overlap=50)
        documents = processor.process(markdown_text, document_title="User Guide")
    """

    # Default configuration
    DEFAULT_CHUNK_SIZE = 1024
    DEFAULT_CHUNK_OVERLAP = 50
    DEFAULT_MIN_CHUNK_SIZE = 256
    DEFAULT_SPLIT_HEADER_LEVEL = 3

    # Code block placeholder prefix
    CODE_BLOCK_PLACEHOLDER_PREFIX = "___CODE_BLOCK_"
    INLINE_CODE_PLACEHOLDER_PREFIX = "___INLINE_CODE_"
    TABLE_PLACEHOLDER_PREFIX = "___TABLE_"

    # Regex patterns
    FENCED_CODE_BLOCK_PATTERN = re.compile(r"```[\w]*\n[\s\S]*?```", re.MULTILINE)
    INLINE_CODE_PATTERN = re.compile(r"`[^`\n]+`")

    # Markdown table pattern: lines with | that have a separator line with ---
    TABLE_PATTERN = re.compile(
        r"(\|[^\n]+\|\n)"  # Header row
        r"(\|[\s\-:|]+\|\n)"  # Separator row
        r"((?:\|[^\n]+\|\n?)+)",  # Data rows
        re.MULTILINE,
    )

    # Noise patterns
    HORIZONTAL_RULE_PATTERN = re.compile(r"^[\s]*[-*_]{3,}[\s]*$", re.MULTILINE)
    EMPTY_LINK_PATTERN = re.compile(r"\[[\s]*\]\([\s#]*\)")
    HTML_COMMENT_PATTERN = re.compile(r"<!--[\s\S]*?-->")
    EXCESSIVE_NEWLINES_PATTERN = re.compile(r"\n{4,}")
    TRAILING_WHITESPACE_PATTERN = re.compile(r"[ \t]+$", re.MULTILINE)
    EMPTY_HEADER_PATTERN = re.compile(r"^#{1,6}\s*$", re.MULTILINE)

    # Image and link patterns
    IMAGE_PATTERN = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
    LINK_PATTERN = re.compile(r"\[([^\]]*)\]\([^)]+\)")  # Allow empty text to match

    def __init__(
        self,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
        min_chunk_size: int = DEFAULT_MIN_CHUNK_SIZE,
        split_header_level: int = DEFAULT_SPLIT_HEADER_LEVEL,
    ):
        """
        Initialize Markdown processor.

        Args:
            chunk_size: Maximum chunk size in characters (default: 1024)
            chunk_overlap: Number of characters to overlap between chunks (default: 50)
            min_chunk_size: Minimum chunk size for merging (default: 256)
            split_header_level: Maximum header level to split on (1-3, default: 3)
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_size = min_chunk_size
        self.split_header_level = min(max(split_header_level, 1), 3)

        # RecursiveCharacterTextSplitter for large chunks
        self._recursive_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separators=["\n\n", "\n", " ", ""],
        )

        # MarkdownHeaderTextSplitter for header-based splitting
        # Build headers_to_split_on based on split_header_level
        headers_to_split_on = [
            ("#", "Header 1"),
        ]
        if self.split_header_level >= 2:
            headers_to_split_on.append(("##", "Header 2"))
        if self.split_header_level >= 3:
            headers_to_split_on.append(("###", "Header 3"))

        self._header_splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=headers_to_split_on,
            strip_headers=False,  # Keep headers in content
        )

    def process(self, markdown_text: str, document_title: str = "") -> List[Document]:
        """
        Execute the complete markdown processing pipeline.

        Processing flow:
        1. Preprocess: Clean markdown and protect code blocks
        2. Split by headers: Divide content by H1-H3 headers
        3. Merge small chunks: Combine chunks below min_chunk_size
        4. Split large chunks: Break up chunks exceeding chunk_size
        5. Inject context: Add document title and header hierarchy prefix

        Args:
            markdown_text: Raw markdown text to process
            document_title: Optional document title for context prefix

        Returns:
            List of LlamaIndex Document objects with processed content
        """
        if not markdown_text or not markdown_text.strip():
            logger.warning("Empty markdown text received")
            return []

        logger.info(
            f"Processing markdown: {len(markdown_text)} chars, "
            f"title='{document_title}'"
        )

        # Step 1: Protect tables first (they may contain inline code), then code blocks, then preprocess
        text, table_placeholders = self._protect_tables(markdown_text)
        text, code_placeholders = self._protect_code_blocks(text)
        text = self._preprocess(text)

        # Extract document title from first H1 if not provided
        if not document_title:
            document_title = self._extract_document_title(text)

        # Step 2: Split by headers
        chunks = self._split_by_headers(text, code_placeholders, table_placeholders)
        logger.debug(f"After header split: {len(chunks)} chunks")

        # Step 3: Merge small chunks
        chunks = self._merge_small_chunks(chunks)
        logger.debug(f"After merge: {len(chunks)} chunks")

        # Step 4: Split large chunks (except code blocks)
        chunks = self._split_large_chunks(chunks)
        logger.debug(f"After split large: {len(chunks)} chunks")

        # Step 5: Restore code blocks, tables and inject context prefix
        documents = self._inject_context_prefix(
            chunks, document_title, code_placeholders, table_placeholders
        )

        logger.info(f"Markdown processing completed: {len(documents)} documents")
        return documents

    # ========================
    # Preprocessing Methods
    # ========================

    def _protect_code_blocks(self, text: str) -> Tuple[str, Dict[str, str]]:
        """
        Replace code blocks with placeholders to protect them from preprocessing.

        Protects both fenced code blocks (```) and inline code (`).

        Args:
            text: Markdown text

        Returns:
            Tuple of (processed text, placeholder-to-code mapping)
        """
        placeholders: Dict[str, str] = {}

        # Protect fenced code blocks first (they may contain inline code syntax)
        def replace_fenced(match: re.Match) -> str:
            placeholder = f"{self.CODE_BLOCK_PLACEHOLDER_PREFIX}{uuid.uuid4().hex}"
            placeholders[placeholder] = match.group(0)
            return placeholder

        text = self.FENCED_CODE_BLOCK_PATTERN.sub(replace_fenced, text)

        # Protect inline code
        def replace_inline(match: re.Match) -> str:
            placeholder = f"{self.INLINE_CODE_PLACEHOLDER_PREFIX}{uuid.uuid4().hex}"
            placeholders[placeholder] = match.group(0)
            return placeholder

        text = self.INLINE_CODE_PATTERN.sub(replace_inline, text)

        logger.debug(f"Protected {len(placeholders)} code blocks")
        return text, placeholders

    def _restore_code_blocks(self, text: str, placeholders: Dict[str, str]) -> str:
        """
        Restore code blocks from placeholders.

        Args:
            text: Text with placeholders
            placeholders: Placeholder-to-code mapping

        Returns:
            Text with code blocks restored
        """
        for placeholder, code in placeholders.items():
            text = text.replace(placeholder, code)
        return text

    def _protect_tables(self, text: str) -> Tuple[str, Dict[str, str]]:
        """
        Replace tables with placeholders to protect them from splitting.

        Tables must be protected BEFORE code blocks, because tables may contain
        inline code that should be protected as part of the table.

        Args:
            text: Markdown text (raw, before code block protection)

        Returns:
            Tuple of (processed text, placeholder-to-table mapping)
        """
        placeholders: Dict[str, str] = {}

        def replace_table(match: re.Match) -> str:
            placeholder = f"{self.TABLE_PLACEHOLDER_PREFIX}{uuid.uuid4().hex}"
            placeholders[placeholder] = match.group(0)
            return placeholder

        text = self.TABLE_PATTERN.sub(replace_table, text)

        logger.debug(f"Protected {len(placeholders)} tables")
        return text, placeholders

    def _restore_tables(self, text: str, placeholders: Dict[str, str]) -> str:
        """
        Restore tables from placeholders.

        Args:
            text: Text with placeholders
            placeholders: Placeholder-to-table mapping

        Returns:
            Text with tables restored
        """
        for placeholder, table in placeholders.items():
            text = text.replace(placeholder, table)
        return text

    def _preprocess(self, text: str) -> str:
        """
        Execute all preprocessing steps on markdown text.

        Steps:
        1. Remove noise elements
        2. Process images and links

        Note: Tables are now protected and NOT converted to key-value format.

        Args:
            text: Markdown text (with code blocks and tables protected)

        Returns:
            Preprocessed text
        """
        text = self._remove_noise(text)
        text = self._process_images_and_links(text)
        return text

    def _convert_tables_to_keyvalue(self, text: str) -> str:
        """
        Convert markdown tables to key-value format.

        Example:
            | Name | Price |
            |------|-------|
            | Apple | $5   |

        Becomes:
            Name: Apple
            Price: $5

        Args:
            text: Markdown text

        Returns:
            Text with tables converted to key-value format
        """

        def convert_table(match: re.Match) -> str:
            header_row = match.group(1)
            # separator_row = match.group(2)  # Not used
            data_rows = match.group(3)

            # Extract headers
            headers = [h.strip() for h in header_row.strip().strip("|").split("|")]

            # Extract and convert data rows
            result_parts = []
            for row in data_rows.strip().split("\n"):
                if not row.strip():
                    continue
                values = [v.strip() for v in row.strip().strip("|").split("|")]

                # Create key-value pairs
                kv_pairs = []
                for i, header in enumerate(headers):
                    if i < len(values) and values[i]:
                        kv_pairs.append(f"{header}: {values[i]}")

                if kv_pairs:
                    result_parts.append("\n".join(kv_pairs))

            return "\n\n".join(result_parts)

        return self.TABLE_PATTERN.sub(convert_table, text)

    def _remove_noise(self, text: str) -> str:
        """
        Remove noise elements from markdown.

        Removes:
        - Horizontal rules (---, ***, ___)
        - Empty/invalid links
        - HTML comments
        - Empty headers (## with no text)
        - Excessive whitespace

        Args:
            text: Markdown text

        Returns:
            Cleaned text
        """
        # Remove horizontal rules
        text = self.HORIZONTAL_RULE_PATTERN.sub("", text)

        # Remove empty links
        text = self.EMPTY_LINK_PATTERN.sub("", text)

        # Remove HTML comments
        text = self.HTML_COMMENT_PATTERN.sub("", text)

        # Remove empty headers (## with no text)
        text = self.EMPTY_HEADER_PATTERN.sub("", text)

        # Remove trailing whitespace from each line
        text = self.TRAILING_WHITESPACE_PATTERN.sub("", text)

        # Compress excessive newlines (4+ -> 2)
        text = self.EXCESSIVE_NEWLINES_PATTERN.sub("\n\n", text)

        return text

    def _process_images_and_links(self, text: str) -> str:
        """
        Process images and links in markdown.

        - Images: ![alt](url) -> removed
        - Links: [text](url) -> text + url (https://...), removed if both empty

        Args:
            text: Markdown text

        Returns:
            Processed text
        """

        # Remove images completely
        text = self.IMAGE_PATTERN.sub("", text)

        # Process links - extract link text and URL
        def process_link(match: re.Match) -> str:
            link_text = match.group(1).strip()
            url = match.group(0)[match.group(0).find("(") + 1:-1].strip()

            # Build result based on what's available
            if link_text and url:
                return f"{link_text} ({url})"
            elif link_text:
                return link_text
            elif url:
                return url
            return ""

        text = self.LINK_PATTERN.sub(process_link, text)

        return text

    def _extract_document_title(self, text: str) -> str:
        """
        Extract document title from first H1 header.

        Args:
            text: Markdown text

        Returns:
            Document title or empty string
        """
        match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        if match:
            return match.group(1).strip()
        return ""

    # ========================
    # Splitting Methods
    # ========================

    def _split_by_headers(
        self, text: str, code_placeholders: Dict[str, str], table_placeholders: Dict[str, str]
    ) -> List[ChunkWithContext]:
        """
        Split text by H1-H3 headers using MarkdownHeaderTextSplitter.

        Creates chunks at each header boundary while maintaining
        header hierarchy information for context.

        Args:
            text: Preprocessed markdown text
            code_placeholders: Mapping of placeholders to code blocks
            table_placeholders: Mapping of placeholders to tables

        Returns:
            List of ChunkWithContext objects
        """
        chunks: List[ChunkWithContext] = []

        # Use MarkdownHeaderTextSplitter to split by headers
        header_docs = self._header_splitter.split_text(text)

        for doc in header_docs:
            content = doc.page_content.strip()
            if not content:
                continue

            # Extract header hierarchy from metadata
            metadata = doc.metadata
            header_hierarchy = []
            header_level = 0

            # Build hierarchy from metadata (H1, H2, H3 in order)
            for i in range(1, 4):
                header_key = f"Header {i}"
                if header_key in metadata and metadata[header_key]:
                    header_hierarchy.append(metadata[header_key])
                    header_level = i

            # Check if chunk contains code blocks or tables
            is_code = self._is_code_block_chunk(content, code_placeholders)
            is_table = self._is_table_chunk(content, table_placeholders)

            chunks.append(
                ChunkWithContext(
                    content=content,
                    header_hierarchy=header_hierarchy,
                    header_level=header_level,
                    is_code_block=is_code,
                    is_table=is_table,
                )
            )

        # If no chunks were created (e.g., no headers), return entire text as single chunk
        if not chunks and text.strip():
            is_code = self._is_code_block_chunk(text, code_placeholders)
            is_table = self._is_table_chunk(text, table_placeholders)
            return [
                ChunkWithContext(
                    content=text.strip(),
                    header_hierarchy=[],
                    header_level=0,
                    is_code_block=is_code,
                    is_table=is_table,
                )
            ]

        return chunks

    def _is_code_block_chunk(
        self, content: str, code_placeholders: Dict[str, str]
    ) -> bool:
        """
        Check if chunk consists primarily of code blocks.

        A chunk is considered a code block chunk if it contains
        fenced code block placeholders.

        Args:
            content: Chunk content
            code_placeholders: Mapping of placeholders

        Returns:
            True if chunk contains code block placeholders
        """
        for placeholder in code_placeholders:
            if (
                placeholder.startswith(self.CODE_BLOCK_PLACEHOLDER_PREFIX)
                and placeholder in content
            ):
                return True
        return False

    def _is_table_chunk(
        self, content: str, table_placeholders: Dict[str, str]
    ) -> bool:
        """
        Check if chunk contains tables.

        Args:
            content: Chunk content
            table_placeholders: Mapping of placeholders

        Returns:
            True if chunk contains table placeholders
        """
        for placeholder in table_placeholders:
            if placeholder in content:
                return True
        return False

    def _merge_small_chunks(
        self, chunks: List[ChunkWithContext]
    ) -> List[ChunkWithContext]:
        """
        Merge chunks smaller than min_chunk_size with adjacent chunks.

        Merging strategy:优先向下合并（前一个块合并到当前块），这样可以
        确保小块被有效吸收。如果向下合并失败，才尝试向上合并（当前块合并到前一个块）。

        Merging rules:
        - Only merge adjacent chunks
        - Preserve higher-level header as merged chunk's header
        - Don't exceed chunk_size after merge
        - Tables can be merged with normal content but are never split
        - Code blocks can be merged with other code blocks
        - Don't merge code blocks with normal content to avoid oversized protected chunks

        Args:
            chunks: List of chunks to process

        Returns:
            List of merged chunks
        """
        if not chunks:
            return chunks

        merged: List[ChunkWithContext] = []
        i = 0

        while i < len(chunks):
            current_chunk = chunks[i]

            # First chunk - just add it
            if not merged:
                merged.append(current_chunk)
                i += 1
                continue

            prev_chunk = merged[-1]

            # Check if either chunk is protected (code or table)
            # Note: Tables can be merged with normal content, only code blocks are protected
            current_protected = current_chunk.is_code_block
            prev_protected = prev_chunk.is_code_block

            # Try to merge previous chunk INTO current chunk (downward merge first)
            # Only merge if previous is small and:
            # - Neither is code protected, OR
            # - Both are code blocks (same protected type)
            can_merge_down = (
                len(prev_chunk) < self.min_chunk_size  # Previous is small
                and len(prev_chunk) + len(current_chunk) <= self.chunk_size  # Size OK
                and (
                    # Case 1: Neither is code protected - safe to merge (tables OK)
                    (not current_protected and not prev_protected)
                    # Case 2: Both are code blocks - merge to reduce fragmentation
                    or (current_chunk.is_code_block and prev_chunk.is_code_block)
                )
            )

            if can_merge_down:
                # Merge previous into current (downward merge)
                current_chunk.content = f"{prev_chunk.content}\n\n{current_chunk.content}"
                if prev_chunk.header_hierarchy and not current_chunk.header_hierarchy:
                    current_chunk.header_hierarchy = prev_chunk.header_hierarchy
                    current_chunk.header_level = prev_chunk.header_level
                # If previous chunk has table/code, propagate the flag
                if prev_chunk.is_table:
                    current_chunk.is_table = True
                if prev_chunk.is_code_block:
                    current_chunk.is_code_block = True
                # Replace previous with current
                merged[-1] = current_chunk
                i += 1
            else:
                # Check if current chunk is small and can be merged upward
                # Only try this if downward merge failed
                can_merge_up = (
                    len(current_chunk) < self.min_chunk_size  # Current is small
                    and len(prev_chunk) + len(current_chunk) <= self.chunk_size  # Size OK
                    and (
                        # Case 1: Neither is code protected - safe to merge (tables OK)
                        (not current_protected and not prev_protected)
                        # Case 2: Both are code blocks - merge to reduce fragmentation
                        or (current_chunk.is_code_block and prev_chunk.is_code_block)
                    )
                )

                if can_merge_up:
                    # Merge current into previous (upward merge)
                    prev_chunk.content = f"{prev_chunk.content}\n\n{current_chunk.content}"
                    # Keep the more specific hierarchy if current chunk has headers
                    if current_chunk.header_hierarchy and (
                        not prev_chunk.header_hierarchy
                        or current_chunk.header_level > prev_chunk.header_level
                    ):
                        prev_chunk.header_hierarchy = current_chunk.header_hierarchy
                        prev_chunk.header_level = current_chunk.header_level
                    # If current chunk has table/code, propagate the flag
                    if current_chunk.is_table:
                        prev_chunk.is_table = True
                    if current_chunk.is_code_block:
                        prev_chunk.is_code_block = True
                    # Move to next chunk (current was merged into prev)
                    i += 1
                else:
                    # Cannot merge either way, add current as new chunk
                    merged.append(current_chunk)
                    i += 1

        return merged

    def _split_large_chunks(
        self, chunks: List[ChunkWithContext]
    ) -> List[ChunkWithContext]:
        """
        Split chunks larger than chunk_size.

        Code blocks are NEVER split, regardless of size.
        Tables can be merged with normal content but are never split within the chunk.

        Args:
            chunks: List of chunks to process

        Returns:
            List of chunks with large ones split
        """
        result: List[ChunkWithContext] = []

        for chunk in chunks:
            # Never split code blocks
            if chunk.is_code_block:
                result.append(chunk)
                continue

            # Check if splitting is needed
            if len(chunk) <= self.chunk_size:
                result.append(chunk)
                continue

            # Split using recursive character splitter
            # Tables are protected by placeholders, so they won't be split
            sub_chunks = self._split_text_content(chunk.content)

            for i, sub_content in enumerate(sub_chunks):
                result.append(
                    ChunkWithContext(
                        content=sub_content,
                        header_hierarchy=chunk.header_hierarchy.copy(),
                        header_level=chunk.header_level,
                        is_code_block=False,
                        is_table=False,
                    )
                )

        return result

    def _split_text_content(self, text: str) -> List[str]:
        """
        Split text content using recursive character splitter.

        Ensures table placeholders are never split across chunks.

        Args:
            text: Text to split

        Returns:
            List of split text chunks
        """
        # Find all table placeholders and their positions
        table_positions = []
        for match in re.finditer(rf"{self.TABLE_PLACEHOLDER_PREFIX}[a-f0-9]+", text):
            table_positions.append((match.start(), match.end(), match.group()))

        # If no tables, use normal splitting
        if not table_positions:
            return self._recursive_splitter.split_text(text)

        # Split using separator that respects table placeholders
        # First, mark table positions as atomic units
        result = []
        current_pos = 0
        separators = ["\n\n", "\n", " ", ""]

        for sep in separators:
            if current_pos >= len(text):
                break

            # Find next separator after current_pos, but not inside a table
            next_sep_pos = -1
            sep_len = len(sep)

            # Find all occurrences of this separator
            for match in re.finditer(re.escape(sep), text[current_pos:]):
                abs_pos = current_pos + match.start()
                # Check if this separator is inside a table placeholder
                inside_table = False
                for table_start, table_end, _ in table_positions:
                    if table_start <= abs_pos < table_end:
                        inside_table = True
                        break

                if not inside_table:
                    next_sep_pos = abs_pos
                    break

            if next_sep_pos == -1:
                # No more valid separators of this type
                continue

            # Check if current chunk would exceed size
            chunk_size = next_sep_pos - current_pos
            if current_pos == 0 and chunk_size <= self.chunk_size:
                # First chunk, add it
                result.append(text[current_pos:next_sep_pos + sep_len])
                current_pos = next_sep_pos + sep_len
            elif chunk_size <= self.chunk_size - self.chunk_overlap:
                # Add chunk if size is acceptable
                result.append(text[current_pos:next_sep_pos + sep_len])
                current_pos = next_sep_pos + sep_len
            else:
                # Chunk too large, try next separator
                continue

        # Add remaining text
        if current_pos < len(text):
            remaining = text[current_pos:]
            if remaining:
                result.append(remaining)

        # If result is empty or only one chunk, return as-is
        if len(result) <= 1:
            return [text] if text else []

        # Check if any chunk is still too large
        final_result = []
        for chunk in result:
            if len(chunk) <= self.chunk_size:
                final_result.append(chunk)
            else:
                # Chunk still too large, need to split but preserve tables
                final_result.extend(self._split_large_chunk_preserving_tables(chunk))

        return final_result

    def _split_large_chunk_preserving_tables(self, text: str) -> List[str]:
        """
        Split a large chunk while preserving table placeholders.

        Args:
            text: Text to split

        Returns:
            List of split text chunks
        """
        # Find all table placeholders
        table_positions = []
        for match in re.finditer(rf"{self.TABLE_PLACEHOLDER_PREFIX}[a-f0-9]+", text):
            table_positions.append((match.start(), match.end(), match.group()))

        result = []
        current_pos = 0

        while current_pos < len(text):
            # Find the next split point
            split_pos = min(current_pos + self.chunk_size - self.chunk_overlap, len(text))

            # Check if split_pos would split a table
            for table_start, table_end, _ in table_positions:
                if current_pos < table_start < split_pos < table_end:
                    # Split would cut through a table, move split point after table
                    split_pos = min(table_end, len(text))
                    break

            # Extract chunk
            chunk = text[current_pos:split_pos]
            if chunk:
                result.append(chunk)

            current_pos = split_pos

        return result

    # ========================
    # Post-processing Methods
    # ========================

    def _inject_context_prefix(
        self,
        chunks: List[ChunkWithContext],
        document_title: str,
        code_placeholders: Dict[str, str],
        table_placeholders: Dict[str, str],
    ) -> List[Document]:
        """
        Inject context prefix and convert to Documents.

        Prefix format:
            [Document: {title}]
            [Location: {hierarchy}]

            {content}

        Args:
            chunks: Processed chunks
            document_title: Document title
            code_placeholders: Mapping to restore code blocks
            table_placeholders: Mapping to restore tables

        Returns:
            List of LlamaIndex Document objects
        """
        documents: List[Document] = []

        for chunk in chunks:
            # Restore code blocks and tables in content
            content = self._restore_code_blocks(chunk.content, code_placeholders)
            content = self._restore_tables(content, table_placeholders)

            # Build prefix
            prefix_parts = []

            if document_title:
                prefix_parts.append(f"[Document: {document_title}]")

            if chunk.header_hierarchy:
                hierarchy_str = " > ".join(chunk.header_hierarchy)
                prefix_parts.append(f"[Location: {hierarchy_str}]")

            # Combine prefix and content
            if prefix_parts:
                prefix = "\n".join(prefix_parts)
                final_content = f"{prefix}\n\n{content}"
            else:
                final_content = content

            # Create document with metadata
            metadata = {
                "document_title": document_title,
                "header_hierarchy": chunk.header_hierarchy,
                "header_level": chunk.header_level,
                "is_code_block": chunk.is_code_block,
                "is_table": chunk.is_table,
            }

            documents.append(Document(text=final_content, metadata=metadata))

        return documents

    def get_config(self) -> dict:
        """
        Get processor configuration for storage.

        Returns:
            Configuration dict
        """
        return {
            "type": "smart",
            "subtype": "markdown_enhanced",
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "min_chunk_size": self.min_chunk_size,
            "split_header_level": self.split_header_level,
        }
