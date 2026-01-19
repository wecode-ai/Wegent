# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Structural Semantic Splitter for document chunking.

This splitter uses a two-phase approach:
1. Structure-based splitting: Parse document structure (headings, paragraphs)
2. LLM semantic boundary splitting: For chunks > 600 tokens, use LLM to determine semantic boundaries

Non-text content (images, tables) is automatically skipped and flagged.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import tiktoken
from llama_index.core import Document
from llama_index.core.schema import BaseNode, TextNode

logger = logging.getLogger(__name__)

# Token limits
MAX_CHUNK_TOKENS = 600
OVERLAP_TOKENS = 80

# Supported file extensions for structural semantic splitting
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".doc", ".md", ".txt"}

# Non-text element patterns (for detection and skipping)
NON_TEXT_PATTERNS = [
    r"!\[.*?\]\(.*?\)",  # Markdown images
    r"<img[^>]*>",  # HTML images
    r"<table[^>]*>.*?</table>",  # HTML tables
    r"\|.*\|.*\|",  # Markdown tables (simplified detection)
]


@dataclass
class ChunkItem:
    """Represents a single chunk of document content."""

    chunk_index: int
    content: str
    token_count: int
    start_position: int
    end_position: int
    forced_split: bool = False


@dataclass
class DocumentChunks:
    """Container for document chunks and metadata."""

    chunks: List[ChunkItem] = field(default_factory=list)
    total_chunks: int = 0
    overlap_tokens: int = OVERLAP_TOKENS
    has_non_text_content: bool = False
    skipped_elements: List[str] = field(default_factory=list)


class StructuralSemanticSplitter:
    """
    Structural semantic document splitter.

    Uses structure preprocessing and LLM semantic boundary detection
    to intelligently split documents into chunks.
    """

    def __init__(
        self,
        llm_client: Optional[Any] = None,
        max_chunk_tokens: int = MAX_CHUNK_TOKENS,
        overlap_tokens: int = OVERLAP_TOKENS,
    ):
        """
        Initialize structural semantic splitter.

        Args:
            llm_client: LLM client for semantic boundary detection
            max_chunk_tokens: Maximum tokens per chunk (default: 600)
            overlap_tokens: Overlap tokens for forced splits (default: 80)
        """
        self.llm_client = llm_client
        self.max_chunk_tokens = max_chunk_tokens
        self.overlap_tokens = overlap_tokens
        # Use cl100k_base encoding (GPT-4, Claude compatible)
        try:
            self.tokenizer = tiktoken.get_encoding("cl100k_base")
        except Exception:
            # Fallback to gpt2 encoding if cl100k_base not available
            self.tokenizer = tiktoken.get_encoding("gpt2")

    def count_tokens(self, text: str) -> int:
        """Count tokens in text using tiktoken."""
        return len(self.tokenizer.encode(text))

    def detect_non_text_content(self, text: str) -> Tuple[bool, List[str]]:
        """
        Detect non-text content (images, tables) in text.

        Returns:
            Tuple of (has_non_text, list of element types detected)
        """
        detected = []
        for pattern in NON_TEXT_PATTERNS:
            if re.search(pattern, text, re.DOTALL | re.IGNORECASE):
                if "img" in pattern or "!" in pattern:
                    if "images" not in detected:
                        detected.append("images")
                elif "table" in pattern or "|" in pattern:
                    if "tables" not in detected:
                        detected.append("tables")
        return len(detected) > 0, detected

    def remove_non_text_content(self, text: str) -> str:
        """Remove non-text content from text."""
        result = text
        for pattern in NON_TEXT_PATTERNS:
            result = re.sub(pattern, "", result, flags=re.DOTALL | re.IGNORECASE)
        # Clean up excessive whitespace
        result = re.sub(r"\n{3,}", "\n\n", result)
        return result.strip()

    def split_by_structure(self, text: str) -> List[str]:
        """
        Split text by structural elements (headings, paragraphs).

        Returns list of structural blocks.
        """
        # Split by markdown headings (# to ######)
        heading_pattern = r"(^#{1,6}\s+.+$)"
        parts = re.split(heading_pattern, text, flags=re.MULTILINE)

        blocks = []
        current_block = ""

        for part in parts:
            part = part.strip()
            if not part:
                continue

            # Check if this is a heading
            if re.match(r"^#{1,6}\s+", part):
                # Save previous block if exists
                if current_block.strip():
                    blocks.append(current_block.strip())
                current_block = part + "\n"
            else:
                # Split by double newlines (paragraphs)
                paragraphs = re.split(r"\n\n+", part)
                for para in paragraphs:
                    para = para.strip()
                    if not para:
                        continue

                    # If adding this paragraph would exceed token limit,
                    # save current block and start new one
                    test_block = current_block + para + "\n\n"
                    if (
                        self.count_tokens(test_block) > self.max_chunk_tokens
                        and current_block.strip()
                    ):
                        blocks.append(current_block.strip())
                        current_block = para + "\n\n"
                    else:
                        current_block = test_block

        # Add final block
        if current_block.strip():
            blocks.append(current_block.strip())

        return blocks

    def split_by_sentences(self, text: str) -> List[str]:
        """
        Split text by sentence boundaries.

        Used for forced splitting when chunks are too large.
        """
        # Split by sentence-ending punctuation
        sentence_pattern = r"([.!?。！？]+[\s]*)"
        parts = re.split(sentence_pattern, text)

        sentences = []
        current = ""

        for i, part in enumerate(parts):
            if i % 2 == 0:  # Content part
                current += part
            else:  # Punctuation part
                current += part
                if current.strip():
                    sentences.append(current.strip())
                current = ""

        # Add remaining content
        if current.strip():
            sentences.append(current.strip())

        return sentences

    def force_split_with_overlap(self, text: str) -> List[Tuple[str, bool]]:
        """
        Force split text that exceeds max tokens.

        Returns list of (chunk_text, forced_split_flag) tuples.
        Applies overlap between chunks.
        """
        sentences = self.split_by_sentences(text)
        if not sentences:
            return [(text, True)]

        chunks = []
        current_chunk = ""
        overlap_buffer = ""

        for sentence in sentences:
            test_chunk = current_chunk + " " + sentence if current_chunk else sentence

            if self.count_tokens(test_chunk) > self.max_chunk_tokens:
                if current_chunk.strip():
                    chunks.append((current_chunk.strip(), True))
                    # Calculate overlap from the end of current chunk
                    overlap_buffer = self._get_overlap_text(current_chunk)
                    current_chunk = overlap_buffer + " " + sentence
                else:
                    # Single sentence exceeds limit - just include it
                    chunks.append((sentence.strip(), True))
                    current_chunk = ""
            else:
                current_chunk = test_chunk

        # Add final chunk
        if current_chunk.strip():
            # Final chunk might not need forced_split flag if it's the only one
            is_forced = len(chunks) > 0
            chunks.append((current_chunk.strip(), is_forced))

        return chunks

    def _get_overlap_text(self, text: str) -> str:
        """Get overlap text from the end of a chunk."""
        tokens = self.tokenizer.encode(text)
        if len(tokens) <= self.overlap_tokens:
            return text

        overlap_tokens = tokens[-self.overlap_tokens :]
        return self.tokenizer.decode(overlap_tokens)

    async def split_by_llm_semantic(self, text: str) -> List[str]:
        """
        Use LLM to determine semantic boundaries for splitting.

        Falls back to force splitting if LLM is not available.
        """
        if not self.llm_client:
            logger.warning(
                "LLM client not available, falling back to sentence-based splitting"
            )
            return [chunk for chunk, _ in self.force_split_with_overlap(text)]

        try:
            prompt = f"""Analyze the following text and identify natural semantic boundaries where it could be split into coherent chunks. Each chunk should be semantically complete and self-contained.

Return the split points as line numbers or character positions where the text should be divided. The goal is to keep related content together while ensuring each chunk is meaningful on its own.

Text to analyze:
---
{text}
---

Identify the best split points to create chunks of roughly equal size while preserving semantic coherence. Return the text split into chunks, with each chunk separated by "===CHUNK_BOUNDARY===".
"""

            response = await self.llm_client.complete(prompt)
            if response and "===CHUNK_BOUNDARY===" in response:
                chunks = [
                    chunk.strip()
                    for chunk in response.split("===CHUNK_BOUNDARY===")
                    if chunk.strip()
                ]
                if chunks:
                    return chunks

            # Fallback to force splitting if LLM response is not useful
            logger.warning("LLM response not useful, falling back to force splitting")
            return [chunk for chunk, _ in self.force_split_with_overlap(text)]

        except Exception as e:
            logger.error(f"LLM semantic splitting failed: {e}")
            return [chunk for chunk, _ in self.force_split_with_overlap(text)]

    def split_documents_with_chunks(
        self, documents: List[Document]
    ) -> Tuple[List[BaseNode], DocumentChunks]:
        """
        Split documents into nodes and return both nodes and chunks data.

        This is a synchronous method that processes documents without
        using the LLM for semantic boundary detection.

        Args:
            documents: List of LlamaIndex Document objects

        Returns:
            Tuple of (List of TextNode objects, DocumentChunks for DB storage)
        """
        nodes = []
        all_chunk_items = []
        has_non_text = False
        all_skipped = set()
        chunk_index = 0

        for doc in documents:
            text = doc.text or ""
            if not text.strip():
                continue

            # Detect and remove non-text content
            doc_has_non_text, skipped = self.detect_non_text_content(text)
            if doc_has_non_text:
                has_non_text = True
                all_skipped.update(skipped)
                text = self.remove_non_text_content(text)
                logger.info(f"Skipped non-text elements: {skipped}")

            # Split by structure first
            structural_blocks = self.split_by_structure(text)

            position = 0
            for block in structural_blocks:
                block_tokens = self.count_tokens(block)

                if block_tokens <= self.max_chunk_tokens:
                    # Block fits within limit
                    node = TextNode(
                        text=block,
                        metadata={
                            **doc.metadata,
                            "start_position": position,
                            "end_position": position + len(block),
                            "token_count": block_tokens,
                            "forced_split": False,
                        },
                    )
                    nodes.append(node)

                    # Create ChunkItem for DB storage
                    chunk_item = ChunkItem(
                        chunk_index=chunk_index,
                        content=block,
                        token_count=block_tokens,
                        start_position=position,
                        end_position=position + len(block),
                        forced_split=False,
                    )
                    all_chunk_items.append(chunk_item)
                    chunk_index += 1
                    position += len(block)
                else:
                    # Block exceeds limit - force split with overlap
                    split_chunks = self.force_split_with_overlap(block)
                    for chunk_text, is_forced in split_chunks:
                        chunk_tokens = self.count_tokens(chunk_text)
                        node = TextNode(
                            text=chunk_text,
                            metadata={
                                **doc.metadata,
                                "start_position": position,
                                "end_position": position + len(chunk_text),
                                "token_count": chunk_tokens,
                                "forced_split": is_forced,
                            },
                        )
                        nodes.append(node)

                        # Create ChunkItem for DB storage
                        chunk_item = ChunkItem(
                            chunk_index=chunk_index,
                            content=chunk_text,
                            token_count=chunk_tokens,
                            start_position=position,
                            end_position=position + len(chunk_text),
                            forced_split=is_forced,
                        )
                        all_chunk_items.append(chunk_item)
                        chunk_index += 1
                        position += len(chunk_text)

        # Build DocumentChunks
        document_chunks = DocumentChunks(
            chunks=all_chunk_items,
            total_chunks=len(all_chunk_items),
            overlap_tokens=self.overlap_tokens,
            has_non_text_content=has_non_text,
            skipped_elements=list(all_skipped),
        )

        return nodes, document_chunks

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Split documents into nodes using structural semantic approach.

        This is a synchronous wrapper that processes documents without
        using the LLM (for compatibility with existing pipeline).

        Args:
            documents: List of LlamaIndex Document objects

        Returns:
            List of TextNode objects
        """
        nodes, _ = self.split_documents_with_chunks(documents)
        return nodes

    async def split_documents_with_llm(
        self, documents: List[Document]
    ) -> Tuple[List[BaseNode], DocumentChunks]:
        """
        Split documents using LLM for semantic boundary detection.

        Returns both nodes (for vector storage) and DocumentChunks (for DB storage).
        """
        nodes = []
        all_chunk_items = []
        has_non_text = False
        all_skipped = set()

        chunk_index = 0
        position = 0

        for doc in documents:
            text = doc.text or ""
            if not text.strip():
                continue

            # Detect and remove non-text content
            doc_has_non_text, skipped = self.detect_non_text_content(text)
            if doc_has_non_text:
                has_non_text = True
                all_skipped.update(skipped)
                text = self.remove_non_text_content(text)

            # Split by structure first
            structural_blocks = self.split_by_structure(text)

            for block in structural_blocks:
                block_tokens = self.count_tokens(block)

                if block_tokens <= self.max_chunk_tokens:
                    # Block fits within limit
                    chunk_item = ChunkItem(
                        chunk_index=chunk_index,
                        content=block,
                        token_count=block_tokens,
                        start_position=position,
                        end_position=position + len(block),
                        forced_split=False,
                    )
                    all_chunk_items.append(chunk_item)

                    node = TextNode(
                        text=block,
                        metadata={
                            **doc.metadata,
                            "chunk_index": chunk_index,
                            "start_position": position,
                            "end_position": position + len(block),
                            "token_count": block_tokens,
                            "forced_split": False,
                        },
                    )
                    nodes.append(node)

                    chunk_index += 1
                    position += len(block)
                else:
                    # Use LLM for semantic splitting
                    llm_chunks = await self.split_by_llm_semantic(block)

                    for chunk_text in llm_chunks:
                        chunk_tokens = self.count_tokens(chunk_text)

                        # Check if still too large after LLM split
                        if chunk_tokens > self.max_chunk_tokens:
                            # Force split with overlap
                            force_split_chunks = self.force_split_with_overlap(
                                chunk_text
                            )
                            for split_text, is_forced in force_split_chunks:
                                split_tokens = self.count_tokens(split_text)
                                chunk_item = ChunkItem(
                                    chunk_index=chunk_index,
                                    content=split_text,
                                    token_count=split_tokens,
                                    start_position=position,
                                    end_position=position + len(split_text),
                                    forced_split=is_forced,
                                )
                                all_chunk_items.append(chunk_item)

                                node = TextNode(
                                    text=split_text,
                                    metadata={
                                        **doc.metadata,
                                        "chunk_index": chunk_index,
                                        "start_position": position,
                                        "end_position": position + len(split_text),
                                        "token_count": split_tokens,
                                        "forced_split": is_forced,
                                    },
                                )
                                nodes.append(node)

                                chunk_index += 1
                                position += len(split_text)
                        else:
                            chunk_item = ChunkItem(
                                chunk_index=chunk_index,
                                content=chunk_text,
                                token_count=chunk_tokens,
                                start_position=position,
                                end_position=position + len(chunk_text),
                                forced_split=False,
                            )
                            all_chunk_items.append(chunk_item)

                            node = TextNode(
                                text=chunk_text,
                                metadata={
                                    **doc.metadata,
                                    "chunk_index": chunk_index,
                                    "start_position": position,
                                    "end_position": position + len(chunk_text),
                                    "token_count": chunk_tokens,
                                    "forced_split": False,
                                },
                            )
                            nodes.append(node)

                            chunk_index += 1
                            position += len(chunk_text)

        # Build DocumentChunks
        doc_chunks = DocumentChunks(
            chunks=all_chunk_items,
            total_chunks=len(all_chunk_items),
            overlap_tokens=self.overlap_tokens,
            has_non_text_content=has_non_text,
            skipped_elements=list(all_skipped),
        )

        return nodes, doc_chunks

    def get_config(self) -> dict:
        """Get splitter configuration."""
        return {
            "type": "structural_semantic",
            "max_chunk_tokens": self.max_chunk_tokens,
            "overlap_tokens": self.overlap_tokens,
        }


def is_structural_semantic_supported(file_extension: str) -> bool:
    """Check if file extension supports structural semantic splitting."""
    ext = file_extension.lower()
    if not ext.startswith("."):
        ext = f".{ext}"
    return ext in SUPPORTED_EXTENSIONS
