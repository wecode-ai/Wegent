# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Validators for document splitting.
"""

from dataclasses import dataclass
from typing import List, Optional

from llama_index.core.schema import TextNode

from app.services.rag.utils.tokenizer import count_tokens

# Markdown chunk size threshold (tokens)
MARKDOWN_MAX_CHUNK_TOKENS = 2000


@dataclass
class OversizedChunk:
    """Information about an oversized chunk."""

    heading: Optional[str]
    token_count: int
    content_preview: str  # First 100 chars


@dataclass
class ValidationResult:
    """Result of chunk validation."""

    is_valid: bool
    oversized_chunks: List[OversizedChunk]
    max_allowed_tokens: int = MARKDOWN_MAX_CHUNK_TOKENS


def validate_markdown_chunks(
    nodes: List[TextNode],
    embedding_model_name: str,
    max_tokens: int = MARKDOWN_MAX_CHUNK_TOKENS,
) -> ValidationResult:
    """
    Validate markdown chunks for size limits.

    Returns ValidationResult with is_valid=False if any chunk exceeds max_tokens.

    Args:
        nodes: List of TextNode objects from splitting
        embedding_model_name: Name of the embedding model for token counting
        max_tokens: Maximum allowed tokens per chunk

    Returns:
        ValidationResult with validation status and oversized chunk info
    """
    oversized = []

    for node in nodes:
        content = node.get_content()
        token_count = count_tokens(content, embedding_model_name)

        if token_count > max_tokens:
            # Extract heading from metadata if available
            heading = node.metadata.get("header_path") or node.metadata.get("section")
            oversized.append(
                OversizedChunk(
                    heading=heading,
                    token_count=token_count,
                    content_preview=(
                        content[:100] + "..." if len(content) > 100 else content
                    ),
                )
            )

    return ValidationResult(
        is_valid=len(oversized) == 0,
        oversized_chunks=oversized,
        max_allowed_tokens=max_tokens,
    )


def format_validation_error(result: ValidationResult) -> dict:
    """
    Format validation result as error response.

    Args:
        result: ValidationResult from validate_markdown_chunks

    Returns:
        Error response dict with error_code, error_message and details
    """
    # Find the largest chunk for the error message
    max_chunk = max(result.oversized_chunks, key=lambda x: x.token_count)

    return {
        "error_code": "CHUNK_TOO_LONG",
        "error_message": (
            f"检测到 Markdown 中某些章节内容过长（约 {max_chunk.token_count} tokens）。"
            f"建议将该章节拆分为多个子标题（### / ####），以获得更好的检索和回答效果。"
        ),
        "details": {
            "max_allowed_tokens": result.max_allowed_tokens,
            "oversized_chunks": [
                {
                    "heading": chunk.heading,
                    "token_count": chunk.token_count,
                    "content_preview": chunk.content_preview,
                }
                for chunk in result.oversized_chunks
            ],
        },
    }
