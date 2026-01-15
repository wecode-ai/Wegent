# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content cleaning utilities for knowledge base chunks.

This module provides functionality to clean knowledge base content
by removing HTML tags and normalizing whitespace to reduce token usage
while preserving important content like URLs, code blocks, and emails.
"""

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)


class KnowledgeContentCleaner:
    """Content cleaner for knowledge base chunks.

    This class provides methods to clean text content by removing
    unnecessary elements that consume tokens but add little value,
    while preserving important content like URLs, code blocks, and emails.
    """

    def __init__(self):
        """Initialize the content cleaner with pre-compiled regex patterns."""
        # HTML tag patterns
        self.html_tag_pattern = re.compile(r"<[^>]+>")

        # HTML entity patterns
        self.html_entity_pattern = re.compile(r"&[a-zA-Z]+;|&#[0-9]+;")

        # Meaningless whitespace patterns (multiple spaces, tabs, newlines)
        self.whitespace_pattern = re.compile(r"\s+")

        # Non-printable characters
        self.non_printable_pattern = re.compile(r"[\x00-\x1f\x7f-\x9f]")

    def _normalize_repeated_punctuation(self, text: str) -> str:
        """Normalize repeated punctuation to single character.

        Converts !!! -> !, ??? -> ?, ... -> .
        Preserves mixed punctuation like ?! or !?

        Args:
            text: Text to normalize

        Returns:
            Text with repeated punctuation normalized
        """
        # Normalize repeated exclamation marks: !!! -> !
        text = re.sub(r"(!)\1+", r"\1", text)
        # Normalize repeated question marks: ??? -> ?
        text = re.sub(r"(\?)\1+", r"\1", text)
        # Normalize repeated periods: ... -> .
        text = re.sub(r"(\.)\1+", r"\1", text)
        return text

    def clean_content(
        self,
        content: str,
        remove_html: bool = True,
        normalize_whitespace: bool = True,
        normalize_punctuation: bool = True,
        remove_non_printable: bool = True,
    ) -> str:
        """Clean content by removing specified elements.

        This method preserves:
        - URLs (http://, https://)
        - Code blocks (``` and `)
        - Email addresses

        This method removes/normalizes:
        - HTML tags (<p>, <div>, etc.)
        - HTML entities (&nbsp;, &#123;, etc.)
        - Repeated punctuation (!!! -> !, ??? -> ?, ... -> .)
        - Multiple whitespace (spaces, newlines -> single space)
        - Non-printable characters

        Args:
            content: The content to clean
            remove_html: Whether to remove HTML tags and entities
            normalize_whitespace: Whether to normalize whitespace
            normalize_punctuation: Whether to normalize repeated punctuation
            remove_non_printable: Whether to remove non-printable characters

        Returns:
            Cleaned content
        """
        if not content:
            return content

        cleaned = content

        # Remove HTML tags and entities
        if remove_html:
            cleaned = self.html_tag_pattern.sub("", cleaned)
            cleaned = self.html_entity_pattern.sub("", cleaned)

        # Normalize repeated punctuation (preserve original type)
        if normalize_punctuation:
            cleaned = self._normalize_repeated_punctuation(cleaned)

        # Remove non-printable characters
        if remove_non_printable:
            cleaned = self.non_printable_pattern.sub("", cleaned)

        # Normalize whitespace
        if normalize_whitespace:
            cleaned = self.whitespace_pattern.sub(" ", cleaned)
            cleaned = cleaned.strip()

        return cleaned

    def clean_knowledge_chunk(
        self,
        chunk: dict,
    ) -> dict:
        """Clean a knowledge base chunk.

        Args:
            chunk: Knowledge base chunk dictionary

        Returns:
            Cleaned chunk dictionary
        """
        if not isinstance(chunk, dict):
            return chunk

        cleaned_chunk = chunk.copy()

        # Get content from chunk
        content = chunk.get("content", "")
        if not content:
            return cleaned_chunk

        # Clean content with default settings
        cleaned_content = self.clean_content(content)

        # Update chunk content
        cleaned_chunk["content"] = cleaned_content

        # Log cleaning statistics
        original_length = len(content)
        cleaned_length = len(cleaned_content)
        if original_length > 0:
            reduction_ratio = (original_length - cleaned_length) / original_length
            logger.debug(
                "[KnowledgeContentCleaner] Cleaned chunk: %d -> %d chars (%.1f%% reduction)",
                original_length,
                cleaned_length,
                reduction_ratio * 100,
            )

        return cleaned_chunk

    def clean_knowledge_chunks(
        self,
        chunks: list[dict],
    ) -> list[dict]:
        """Clean multiple knowledge base chunks.

        Args:
            chunks: List of knowledge base chunk dictionaries

        Returns:
            List of cleaned chunks
        """
        if not chunks:
            return chunks

        cleaned_chunks = []
        total_original_length = 0
        total_cleaned_length = 0

        for chunk in chunks:
            cleaned_chunk = self.clean_knowledge_chunk(chunk)
            cleaned_chunks.append(cleaned_chunk)

            # Track statistics
            total_original_length += len(chunk.get("content", ""))
            total_cleaned_length += len(cleaned_chunk.get("content", ""))

        # Log overall statistics
        if total_original_length > 0:
            overall_reduction = (
                total_original_length - total_cleaned_length
            ) / total_original_length
            logger.info(
                "[KnowledgeContentCleaner] Cleaned %d chunks: %d -> %d chars (%.1f%% reduction)",
                len(chunks),
                total_original_length,
                total_cleaned_length,
                overall_reduction * 100,
            )

        return cleaned_chunks

    def estimate_token_reduction(
        self,
        content: str,
        chars_per_token: float = 4.0,
    ) -> tuple[int, int]:
        """Estimate token reduction after cleaning.

        Args:
            content: Content to analyze
            chars_per_token: Average characters per token for estimation

        Returns:
            Tuple of (original_tokens, estimated_cleaned_tokens)
        """
        if not content:
            return 0, 0

        original_tokens = int(len(content) / chars_per_token)

        # Clean content
        cleaned_content = self.clean_content(content)
        cleaned_tokens = int(len(cleaned_content) / chars_per_token)

        return original_tokens, cleaned_tokens


# Global instance for convenience
_content_cleaner: Optional[KnowledgeContentCleaner] = None


def get_content_cleaner() -> KnowledgeContentCleaner:
    """Get the global content cleaner instance.

    Returns:
        KnowledgeContentCleaner instance
    """
    global _content_cleaner
    if _content_cleaner is None:
        _content_cleaner = KnowledgeContentCleaner()
    return _content_cleaner


def clean_content(content: str) -> str:
    """Convenience function to clean content.

    Args:
        content: Content to clean

    Returns:
        Cleaned content
    """
    cleaner = get_content_cleaner()
    return cleaner.clean_content(content)


def clean_knowledge_chunks(chunks: list[dict]) -> list[dict]:
    """Convenience function to clean knowledge chunks.

    Args:
        chunks: List of knowledge base chunks

    Returns:
        List of cleaned chunks
    """
    cleaner = get_content_cleaner()
    return cleaner.clean_knowledge_chunks(chunks)
