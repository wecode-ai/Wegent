# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Markdown intelligent chunking processor.

This module provides enhanced markdown processing with:
1. Preprocessing: Table conversion, noise removal, code block protection
2. Header-based splitting: Split by H1-H3 headers
3. Chunk merging: Merge small chunks below threshold
4. Chunk splitting: Split large chunks (except code blocks)
5. Context injection: Add document title and header hierarchy prefix

Processing flow:
    Preprocess → Split by Headers → Merge Small → Split Large → Inject Context
"""

import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from llama_index.core import Document
from llama_index.core.node_parser import SentenceSplitter

logger = logging.getLogger(__name__)


@dataclass
class ChunkWithContext:
    """Chunk with context information for processing."""

    content: str
    header_hierarchy: List[str] = field(default_factory=list)
    header_level: int = 0  # 0 means no header, 1-3 for H1-H3
    is_code_block: bool = False

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

    # Header pattern for H1-H3
    HEADER_PATTERN = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)

    # Noise patterns
    HORIZONTAL_RULE_PATTERN = re.compile(r"^[\s]*[-*_]{3,}[\s]*$", re.MULTILINE)
    EMPTY_LINK_PATTERN = re.compile(r"\[[\s]*\]\([\s#]*\)")
    HTML_COMMENT_PATTERN = re.compile(r"<!--[\s\S]*?-->")
    EXCESSIVE_NEWLINES_PATTERN = re.compile(r"\n{4,}")
    TRAILING_WHITESPACE_PATTERN = re.compile(r"[ \t]+$", re.MULTILINE)

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

        # Sentence splitter for large chunks
        self._sentence_splitter = SentenceSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
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

        # Step 1: Protect code blocks and preprocess
        text, code_placeholders = self._protect_code_blocks(markdown_text)
        text = self._preprocess(text)

        # Extract document title from first H1 if not provided
        if not document_title:
            document_title = self._extract_document_title(text)

        # Step 2: Split by headers
        chunks = self._split_by_headers(text, code_placeholders)
        logger.debug(f"After header split: {len(chunks)} chunks")

        # Step 3: Merge small chunks
        chunks = self._merge_small_chunks(chunks)
        logger.debug(f"After merge: {len(chunks)} chunks")

        # Step 4: Split large chunks (except code blocks)
        chunks = self._split_large_chunks(chunks)
        logger.debug(f"After split large: {len(chunks)} chunks")

        # Step 5: Restore code blocks and inject context prefix
        documents = self._inject_context_prefix(
            chunks, document_title, code_placeholders
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

    def _preprocess(self, text: str) -> str:
        """
        Execute all preprocessing steps on markdown text.

        Steps:
        1. Convert tables to key-value format
        2. Remove noise elements
        3. Process images and links

        Args:
            text: Markdown text (with code blocks protected)

        Returns:
            Preprocessed text
        """
        text = self._convert_tables_to_keyvalue(text)
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

        # Remove trailing whitespace from each line
        text = self.TRAILING_WHITESPACE_PATTERN.sub("", text)

        # Compress excessive newlines (4+ -> 2)
        text = self.EXCESSIVE_NEWLINES_PATTERN.sub("\n\n", text)

        return text

    def _process_images_and_links(self, text: str) -> str:
        """
        Process images and links in markdown.

        - Images: ![alt](url) -> [Image: alt] or removed if alt is empty
        - Links: [text](url) -> text or removed if text is empty

        Args:
            text: Markdown text

        Returns:
            Processed text
        """

        # Process images
        def process_image(match: re.Match) -> str:
            alt_text = match.group(1).strip()
            if alt_text:
                return f"[Image: {alt_text}]"
            return ""

        text = self.IMAGE_PATTERN.sub(process_image, text)

        # Process links - extract link text only
        def process_link(match: re.Match) -> str:
            link_text = match.group(1).strip()
            return link_text if link_text else ""

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
        self, text: str, code_placeholders: Dict[str, str]
    ) -> List[ChunkWithContext]:
        """
        Split text by H1-H3 headers.

        Creates chunks at each header boundary while maintaining
        header hierarchy information for context.

        Args:
            text: Preprocessed markdown text
            code_placeholders: Mapping of placeholders to code blocks

        Returns:
            List of ChunkWithContext objects
        """
        chunks: List[ChunkWithContext] = []
        current_hierarchy: List[str] = ["", "", ""]  # H1, H2, H3

        # Find all headers with their positions
        header_matches = list(self.HEADER_PATTERN.finditer(text))

        if not header_matches:
            # No headers found, return entire text as single chunk
            is_code = self._is_code_block_chunk(text, code_placeholders)
            return [
                ChunkWithContext(
                    content=text.strip(),
                    header_hierarchy=[],
                    header_level=0,
                    is_code_block=is_code,
                )
            ]

        # Process content before first header
        if header_matches[0].start() > 0:
            preamble = text[: header_matches[0].start()].strip()
            if preamble:
                is_code = self._is_code_block_chunk(preamble, code_placeholders)
                chunks.append(
                    ChunkWithContext(
                        content=preamble,
                        header_hierarchy=[],
                        header_level=0,
                        is_code_block=is_code,
                    )
                )

        # Process each header section
        for i, match in enumerate(header_matches):
            level = len(match.group(1))  # Number of # symbols
            title = match.group(2).strip()

            # Update hierarchy
            current_hierarchy[level - 1] = title
            # Clear lower levels
            for j in range(level, 3):
                current_hierarchy[j] = ""

            # Get content until next header or end
            start = match.end()
            end = (
                header_matches[i + 1].start()
                if i + 1 < len(header_matches)
                else len(text)
            )
            content = text[start:end].strip()

            # Build hierarchy list (non-empty entries up to current level)
            hierarchy = [h for h in current_hierarchy[:level] if h]

            # Only split on H1-H3 (based on split_header_level)
            if level <= self.split_header_level:
                # Include header in content
                header_line = f"{'#' * level} {title}"
                full_content = f"{header_line}\n\n{content}".strip()

                is_code = self._is_code_block_chunk(full_content, code_placeholders)
                chunks.append(
                    ChunkWithContext(
                        content=full_content,
                        header_hierarchy=hierarchy,
                        header_level=level,
                        is_code_block=is_code,
                    )
                )
            else:
                # H4-H6: Append to previous chunk
                if chunks:
                    header_line = f"{'#' * level} {title}"
                    chunks[-1].content += f"\n\n{header_line}\n\n{content}"
                    # Update code block status
                    chunks[-1].is_code_block = self._is_code_block_chunk(
                        chunks[-1].content, code_placeholders
                    )

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

    def _merge_small_chunks(
        self, chunks: List[ChunkWithContext]
    ) -> List[ChunkWithContext]:
        """
        Merge chunks smaller than min_chunk_size with adjacent chunks.

        Merging rules:
        - Only merge adjacent chunks
        - Preserve higher-level header as merged chunk's header
        - Don't exceed chunk_size after merge

        Args:
            chunks: List of chunks to process

        Returns:
            List of merged chunks
        """
        if not chunks:
            return chunks

        merged: List[ChunkWithContext] = []

        for chunk in chunks:
            if not merged:
                merged.append(chunk)
                continue

            prev_chunk = merged[-1]

            # Check if current chunk should be merged with previous
            should_merge = (
                len(chunk) < self.min_chunk_size
                and len(prev_chunk) + len(chunk) <= self.chunk_size
                and not chunk.is_code_block  # Don't merge code blocks
                and not prev_chunk.is_code_block
            )

            if should_merge:
                # Merge: append content, keep higher-level header info
                prev_chunk.content = f"{prev_chunk.content}\n\n{chunk.content}"
                # Keep the more specific hierarchy if current chunk has headers
                if chunk.header_hierarchy and (
                    not prev_chunk.header_hierarchy
                    or chunk.header_level > prev_chunk.header_level
                ):
                    # Update hierarchy to include both
                    prev_chunk.header_hierarchy = chunk.header_hierarchy
                    prev_chunk.header_level = chunk.header_level
            else:
                # Check if previous chunk is too small and can be merged forward
                if (
                    len(prev_chunk) < self.min_chunk_size
                    and len(prev_chunk) + len(chunk) <= self.chunk_size
                    and not chunk.is_code_block
                    and not prev_chunk.is_code_block
                ):
                    # Merge previous into current
                    chunk.content = f"{prev_chunk.content}\n\n{chunk.content}"
                    if prev_chunk.header_hierarchy and not chunk.header_hierarchy:
                        chunk.header_hierarchy = prev_chunk.header_hierarchy
                    merged[-1] = chunk
                else:
                    merged.append(chunk)

        return merged

    def _split_large_chunks(
        self, chunks: List[ChunkWithContext]
    ) -> List[ChunkWithContext]:
        """
        Split chunks larger than chunk_size.

        Code blocks are NEVER split, regardless of size.

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

            # Split using sentence splitter
            sub_chunks = self._split_text_content(chunk.content)

            for i, sub_content in enumerate(sub_chunks):
                result.append(
                    ChunkWithContext(
                        content=sub_content,
                        header_hierarchy=chunk.header_hierarchy.copy(),
                        header_level=chunk.header_level,
                        is_code_block=False,
                    )
                )

        return result

    def _split_text_content(self, text: str) -> List[str]:
        """
        Split text content using sentence splitter.

        Args:
            text: Text to split

        Returns:
            List of split text chunks
        """
        doc = Document(text=text)
        nodes = self._sentence_splitter.get_nodes_from_documents([doc])
        return [node.text for node in nodes]

    # ========================
    # Post-processing Methods
    # ========================

    def _inject_context_prefix(
        self,
        chunks: List[ChunkWithContext],
        document_title: str,
        code_placeholders: Dict[str, str],
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

        Returns:
            List of LlamaIndex Document objects
        """
        documents: List[Document] = []

        for chunk in chunks:
            # Restore code blocks in content
            content = self._restore_code_blocks(chunk.content, code_placeholders)

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
