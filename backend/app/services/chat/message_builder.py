# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message builder for Chat Shell."""

from typing import Any


def is_vision_message(message: Any) -> bool:
    """Check if message is a vision message (single or multi)."""
    return isinstance(message, dict) and message.get("type") in (
        "vision",
        "multi_vision",
    )


def build_vision_content(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Build OpenAI-compatible vision content blocks from a vision message dict."""
    # Handle multi_vision type (multiple images)
    if message.get("type") == "multi_vision":
        content = [{"type": "text", "text": message.get("text", "")}]

        # Add all images
        for image_data in message.get("images", []):
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{image_data['mime_type']};base64,{image_data['image_base64']}"
                    },
                }
            )

        return content

    # Handle single vision type
    return [
        {"type": "text", "text": message.get("text", "")},
        {
            "type": "image_url",
            "image_url": {
                "url": f"data:{message['mime_type']};base64,{message['image_base64']}"
            },
        },
    ]


def normalize_user_content(message: str | dict[str, Any]) -> str | list[dict[str, Any]]:
    """Normalize user message content for storage or API calls."""
    if is_vision_message(message):
        return build_vision_content(message)
    return message if isinstance(message, str) else str(message)


class MessageBuilder:
    """Builds message lists for LLM API calls."""

    def build_messages(
        self,
        history: list[dict[str, str]],
        current_message: str | dict[str, Any],
        system_prompt: str = "",
    ) -> list[dict[str, Any]]:
        """Build message list for LLM API."""
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.extend(history)
        messages.append(self._format_user_message(current_message))
        return messages

    def _format_user_message(self, message: str | dict[str, Any]) -> dict[str, Any]:
        """Format user message for LLM API (text or vision)."""
        content = normalize_user_content(message)
        return {"role": "user", "content": content}

    def normalize_user_message_for_storage(
        self, message: str | dict[str, Any]
    ) -> str | list[dict[str, Any]]:
        """Normalize user message for storage in chat history."""
        return normalize_user_content(message)

    def append_tool_messages(
        self,
        messages: list[dict[str, Any]],
        assistant_content: str,
        tool_calls: list[dict[str, Any]],
        tool_results: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Append tool call and result messages to the message list."""
        messages.append(
            {
                "role": "assistant",
                "content": assistant_content or None,
                "tool_calls": tool_calls,
            }
        )
        messages.extend(tool_results)
        return messages


# Global message builder instance
message_builder = MessageBuilder()
