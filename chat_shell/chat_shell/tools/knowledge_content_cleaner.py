# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content cleaning utilities for knowledge base chunks.

This module provides functionality to clean knowledge base content
by removing URLs, HTML tags, and meaningless characters to reduce token usage.
"""

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)


class KnowledgeContentCleaner:
    """Content cleaner for knowledge base chunks.

    This class provides methods to clean text content by removing
    unnecessary elements that consume tokens but add little value.
    """

    def __init__(self):
        """Initialize the content cleaner with pre-compiled regex patterns."""
        # URL patterns
        self.url_pattern = re.compile(
            r"http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+"
        )

        # HTML tag patterns
        self.html_tag_pattern = re.compile(r"<[^>]+>")

        # HTML entity patterns
        self.html_entity_pattern = re.compile(r"&[a-zA-Z]+;|&#[0-9]+;")

        # Meaningless whitespace patterns (multiple spaces, tabs, newlines)
        self.whitespace_pattern = re.compile(r"\s+")

        # Meaningless punctuation patterns (repeated punctuation)
        self.repeated_punctuation_pattern = re.compile(r"[.!?]{2,}")

        # Non-printable characters
        self.non_printable_pattern = re.compile(r"[\x00-\x1f\x7f-\x9f]")

        # Email patterns (optional, can be kept if needed)
        self.email_pattern = re.compile(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"
        )

        # Code block markers
        self.code_block_pattern = re.compile(r"```[\s\S]*?```")

        # Inline code markers
        self.inline_code_pattern = re.compile(r"`[^`]*`")

    def clean_content(
        self,
        content: str,
        remove_urls: bool = True,
        remove_html: bool = True,
        remove_emails: bool = False,
        remove_code_blocks: bool = False,
        normalize_whitespace: bool = True,
        remove_repeated_punctuation: bool = True,
        remove_non_printable: bool = True,
        aggressive: bool = False,
    ) -> str:
        """Clean content by removing specified elements.

        Args:
            content: The content to clean
            remove_urls: Whether to remove URLs
            remove_html: Whether to remove HTML tags and entities
            remove_emails: Whether to remove email addresses
            remove_code_blocks: Whether to remove code blocks
            normalize_whitespace: Whether to normalize whitespace
            remove_repeated_punctuation: Whether to remove repeated punctuation
            remove_non_printable: Whether to remove non-printable characters

        Returns:
            Cleaned content
        """
        if not content:
            return content

        cleaned = content

        # Remove URLs
        if remove_urls:
            cleaned = self.url_pattern.sub("", cleaned)

        # Remove HTML tags and entities
        if remove_html:
            cleaned = self.html_tag_pattern.sub("", cleaned)
            cleaned = self.html_entity_pattern.sub("", cleaned)

        # If aggressive mode, remove more content
        if aggressive:
            # Remove emails in aggressive mode
            if not remove_emails:
                cleaned = self.email_pattern.sub("", cleaned)
            # Remove code blocks in aggressive mode
            if not remove_code_blocks:
                cleaned = self.code_block_pattern.sub("[Code Block]", cleaned)
                cleaned = self.inline_code_pattern.sub("[Code]", cleaned)

        # Remove email addresses
        if remove_emails:
            cleaned = self.email_pattern.sub("", cleaned)

        # Remove code blocks
        if remove_code_blocks:
            cleaned = self.code_block_pattern.sub("[Code Block]", cleaned)
            cleaned = self.inline_code_pattern.sub("[Code]", cleaned)

        # Remove repeated punctuation
        if remove_repeated_punctuation:
            cleaned = self.repeated_punctuation_pattern.sub(".", cleaned)

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
        aggressive: bool = False,
    ) -> dict:
        """Clean a knowledge base chunk.

        Args:
            chunk: Knowledge base chunk dictionary
            aggressive: Whether to use aggressive cleaning (removes more content)

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

        # Determine cleaning parameters based on aggressiveness
        cleaned_content = self.clean_content(
            content,
            remove_urls=True,
            remove_html=True,
            remove_emails=aggressive,
            remove_code_blocks=aggressive,
            normalize_whitespace=True,
            remove_repeated_punctuation=True,
            remove_non_printable=True,
            aggressive=aggressive,
        )

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
        aggressive: bool = False,
    ) -> list[dict]:
        """Clean multiple knowledge base chunks.

        Args:
            chunks: List of knowledge base chunk dictionaries
            aggressive: Whether to use aggressive cleaning

        Returns:
            List of cleaned chunks
        """
        if not chunks:
            return chunks

        cleaned_chunks = []
        total_original_length = 0
        total_cleaned_length = 0

        for chunk in chunks:
            cleaned_chunk = self.clean_knowledge_chunk(chunk, aggressive)
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
        aggressive: bool = False,
        chars_per_token: float = 4.0,
    ) -> tuple[int, int]:
        """Estimate token reduction after cleaning.

        Args:
            content: Content to analyze
            aggressive: Whether to use aggressive cleaning
            chars_per_token: Average characters per token for estimation

        Returns:
            Tuple of (original_tokens, estimated_cleaned_tokens)
        """
        if not content:
            return 0, 0

        original_tokens = int(len(content) / chars_per_token)

        # Clean content
        cleaned_content = self.clean_content(content, aggressive=aggressive)
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


def clean_content(content: str, aggressive: bool = False) -> str:
    """Convenience function to clean content.

    Args:
        content: Content to clean
        aggressive: Whether to use aggressive cleaning

    Returns:
        Cleaned content
    """
    cleaner = get_content_cleaner()
    return cleaner.clean_content(content, aggressive=aggressive)


def clean_knowledge_chunks(chunks: list[dict], aggressive: bool = False) -> list[dict]:
    """Convenience function to clean knowledge chunks.

    Args:
        chunks: List of knowledge base chunks
        aggressive: Whether to use aggressive cleaning

    Returns:
        List of cleaned chunks
    """
    cleaner = get_content_cleaner()
    return cleaner.clean_knowledge_chunks(chunks, aggressive=aggressive)
