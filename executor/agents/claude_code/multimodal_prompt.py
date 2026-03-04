# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Multimodal prompt utilities for Claude Code agent.

Handles conversion between OpenAI Responses API vision format and
Anthropic Messages API format, and creates async generators for
the Claude SDK's multimodal query path.
"""

import re
from typing import Any, AsyncGenerator, Union


def is_vision_prompt(prompt: Union[str, list]) -> bool:
    """Check if a prompt contains vision content blocks.

    Args:
        prompt: Either a string prompt or a list of content blocks.

    Returns:
        True if prompt is a list containing vision content blocks.
    """
    if not isinstance(prompt, list) or len(prompt) == 0:
        return False
    return any(
        isinstance(block, dict) and block.get("type") in ("input_image", "image")
        for block in prompt
    )


def append_text_to_vision_prompt(
    prompt: list[dict[str, Any]],
    text: str,
    prepend: bool = False,
) -> list[dict[str, Any]]:
    """Append or prepend text to the text block in a vision content list.

    If an input_text block exists, the text is added to it.
    Otherwise, a new input_text block is inserted at the appropriate position.

    Args:
        prompt: List of OpenAI Responses API content blocks.
        text: Text to append or prepend.
        prepend: If True, prepend text; otherwise append.

    Returns:
        Updated list of content blocks (new list, original not mutated).
    """
    result = [block.copy() for block in prompt]

    # Find existing text block
    for block in result:
        if block.get("type") == "input_text":
            if prepend:
                block["text"] = text + "\n\n" + block["text"]
            else:
                block["text"] = block["text"] + "\n" + text
            return result

    # No text block found — create one
    new_block = {"type": "input_text", "text": text}
    if prepend:
        result.insert(0, new_block)
    else:
        result.append(new_block)
    return result


def convert_openai_to_anthropic_content(
    content_blocks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert OpenAI Responses API content blocks to Anthropic Messages API format.

    Conversions:
    - input_text -> text
    - input_image (data URI) -> image with base64 source

    Args:
        content_blocks: List of OpenAI Responses API content blocks.

    Returns:
        List of Anthropic Messages API content blocks.
    """
    anthropic_blocks: list[dict[str, Any]] = []

    for block in content_blocks:
        block_type = block.get("type", "")

        if block_type == "input_text":
            anthropic_blocks.append({
                "type": "text",
                "text": block.get("text", ""),
            })

        elif block_type == "input_image":
            image_url = block.get("image_url", "")
            media_type, data = _parse_data_uri(image_url)
            anthropic_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": data,
                },
            })

        else:
            # Pass through unknown block types as-is
            anthropic_blocks.append(block)

    return anthropic_blocks


async def create_multimodal_query(
    anthropic_content: list[dict[str, Any]],
) -> AsyncGenerator[dict[str, Any], None]:
    """Create an async generator that yields a multimodal user message for the SDK.

    The Claude SDK query() method accepts either a string or an AsyncIterable
    of message dicts. This function creates the async iterable path for
    multimodal content.

    Args:
        anthropic_content: Anthropic Messages API content blocks.

    Yields:
        A single user message dict compatible with the Claude SDK.
    """
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": anthropic_content,
        },
    }


def _parse_data_uri(data_uri: str) -> tuple[str, str]:
    """Parse a data URI into media type and base64 data.

    Args:
        data_uri: A data URI string like "data:image/png;base64,iVBOR..."

    Returns:
        Tuple of (media_type, base64_data). Defaults to
        ("image/png", data_uri) if parsing fails.
    """
    match = re.match(r"^data:([^;]+);base64,(.+)$", data_uri, re.DOTALL)
    if match:
        return match.group(1), match.group(2)
    return "image/png", data_uri
