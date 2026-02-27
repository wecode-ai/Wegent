# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message builder for Simple Chat service."""

from typing import Any


def is_vision_message(message: Any) -> bool:
    """Check if message is a vision message (OpenAI Responses API format).

    OpenAI Responses API format is a list of content blocks:
    [{"type": "input_text", "text": "..."}, {"type": "input_image", "image_url": "data:..."}]
    """
    if not isinstance(message, list):
        return False
    return any(
        isinstance(block, dict) and block.get("type") in ("input_text", "input_image")
        for block in message
    )


def convert_responses_api_to_chat_completions(
    content_blocks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert OpenAI Responses API format to Chat Completions format.

    OpenAI Responses API format:
    [
        {"type": "input_text", "text": "..."},
        {"type": "input_image", "image_url": "data:image/png;base64,..."},
    ]

    OpenAI Chat Completions format:
    [
        {"type": "text", "text": "..."},
        {"type": "image_url", "image_url": {"url": "data:..."}},
    ]
    """
    result: list[dict[str, Any]] = []

    for block in content_blocks:
        block_type = block.get("type", "")

        if block_type == "input_text":
            result.append({"type": "text", "text": block.get("text", "")})

        elif block_type == "input_image":
            image_url = block.get("image_url", "")
            if image_url:
                result.append({"type": "image_url", "image_url": {"url": image_url}})

    return result


def normalize_user_content(
    message: str | list[dict[str, Any]],
) -> str | list[dict[str, Any]]:
    """Normalize user message content for storage or API calls."""
    if is_vision_message(message):
        return convert_responses_api_to_chat_completions(message)
    return message if isinstance(message, str) else str(message)


class MessageBuilder:
    """Builds message lists for LLM API calls."""

    def build_messages(
        self,
        history: list[dict[str, str]],
        current_message: str | list[dict[str, Any]],
        system_prompt: str = "",
    ) -> list[dict[str, Any]]:
        """Build message list for LLM API.

        Args:
            history: Previous messages in the conversation
            current_message: The current user message. Can be:
                - string: Plain text message
                - list[dict]: OpenAI Responses API format content blocks
                  [{"type": "input_text", "text": "..."}, {"type": "input_image", "image_url": "data:..."}]
            system_prompt: Optional system prompt to prepend

        Returns:
            List of message dicts ready for LLM API (OpenAI Chat Completions format)
        """
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.extend(history)
        messages.append(self._format_user_message(current_message))
        return messages

    def _format_user_message(
        self, message: str | list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Format user message for LLM API (text or vision)."""
        content = normalize_user_content(message)
        return {"role": "user", "content": content}
