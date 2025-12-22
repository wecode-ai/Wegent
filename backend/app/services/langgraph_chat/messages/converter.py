# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message converter utilities for LangGraph Chat Service."""

import base64
from typing import Any


class MessageConverter:
    """Utilities for building and converting messages.

    Note: For converting OpenAI-style dicts to LangChain messages,
    use langchain_core.messages.utils.convert_to_messages directly.
    """

    @staticmethod
    def build_messages(
        history: list[dict[str, Any]],
        current_message: str | dict[str, Any],
        system_prompt: str = "",
    ) -> list[dict[str, Any]]:
        """Build a complete message list from history, current message, and system prompt.

        Combines:
        - System prompt (if provided)
        - Chat history
        - Current user message

        Args:
            history: Previous messages in the conversation
            current_message: The current user message (string or vision dict)
            system_prompt: Optional system prompt to prepend

        Returns:
            List of message dicts ready for LLM API
        """
        messages: list[dict[str, Any]] = []

        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        messages.extend(history)

        if isinstance(current_message, dict):
            if current_message.get("type") == "vision":
                messages.append(
                    MessageConverter._build_vision_from_dict(current_message)
                )
            else:
                messages.append(current_message)
        else:
            messages.append({"role": "user", "content": current_message})

        return messages

    @staticmethod
    def _build_vision_from_dict(vision_data: dict[str, Any]) -> dict[str, Any]:
        """Build vision message from a vision data dict."""
        return MessageConverter.build_vision_message(
            text=vision_data.get("text", ""),
            image_base64=vision_data.get("image_base64", ""),
            mime_type=vision_data.get("mime_type", "image/png"),
        )

    @staticmethod
    def build_vision_message(
        text: str = "",
        image_base64: str = "",
        mime_type: str = "image/png",
    ) -> dict[str, Any]:
        """Build a vision message with text and image."""
        content: list[dict[str, Any]] = []

        if text:
            content.append({"type": "text", "text": text})

        if image_base64:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{image_base64}"},
                }
            )

        return {"role": "user", "content": content}

    @staticmethod
    def build_user_message(content: str, username: str | None = None) -> dict[str, Any]:
        """Build a user message with optional username prefix (for group chat)."""
        text = f"User[{username}]: {content}" if username else content
        return {"role": "user", "content": text}

    @staticmethod
    def extract_text(message: dict[str, Any] | str) -> str:
        """Extract text content from a message."""
        if isinstance(message, str):
            return message

        content = message.get("content", "")
        if isinstance(content, str):
            return content

        if isinstance(content, list):
            return " ".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )

        return str(content)

    @staticmethod
    def is_vision_message(message: dict[str, Any]) -> bool:
        """Check if a message contains vision/image content."""
        content = message.get("content", "")
        if isinstance(content, list):
            return any(
                isinstance(part, dict) and part.get("type") == "image_url"
                for part in content
            )
        return False

    @staticmethod
    def create_image_block(
        image_data: bytes, mime_type: str = "image/png"
    ) -> dict[str, Any]:
        """Create an image content block from raw bytes."""
        encoded = base64.b64encode(image_data).decode("utf-8")
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{encoded}"},
        }
