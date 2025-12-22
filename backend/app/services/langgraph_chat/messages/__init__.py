# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message converter module for LangGraph Chat Service.

This module handles conversion between different message formats:
- OpenAI-style message dicts
- LangChain message objects
- Vision/multimodal messages
"""

import base64
import logging
from typing import Any

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

logger = logging.getLogger(__name__)


class MessageConverter:
    """Converts messages between different formats."""

    @staticmethod
    def dict_to_langchain(messages: list[dict[str, Any]]) -> list[BaseMessage]:
        """
        Convert OpenAI-style message dicts to LangChain message objects.

        Args:
            messages: List of message dicts with 'role' and 'content' keys

        Returns:
            List of LangChain BaseMessage objects
        """
        lc_messages: list[BaseMessage] = []

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                # Handle vision messages (content can be a list)
                if isinstance(content, list):
                    lc_messages.append(HumanMessage(content=content))
                else:
                    lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                # Check for tool calls
                tool_calls = msg.get("tool_calls")
                if tool_calls:
                    lc_messages.append(
                        AIMessage(content=content, tool_calls=tool_calls)
                    )
                else:
                    lc_messages.append(AIMessage(content=content))
            elif role == "tool":
                lc_messages.append(
                    ToolMessage(
                        content=content,
                        tool_call_id=msg.get("tool_call_id", ""),
                        name=msg.get("name", ""),
                    )
                )

        return lc_messages

    @staticmethod
    def langchain_to_dict(messages: list[BaseMessage]) -> list[dict[str, Any]]:
        """
        Convert LangChain message objects to OpenAI-style dicts.

        Args:
            messages: List of LangChain BaseMessage objects

        Returns:
            List of message dicts
        """
        result: list[dict[str, Any]] = []

        for msg in messages:
            if isinstance(msg, SystemMessage):
                result.append({"role": "system", "content": msg.content})
            elif isinstance(msg, HumanMessage):
                result.append({"role": "user", "content": msg.content})
            elif isinstance(msg, AIMessage):
                msg_dict: dict[str, Any] = {
                    "role": "assistant",
                    "content": msg.content if isinstance(msg.content, str) else "",
                }
                # Include tool calls if present
                if hasattr(msg, "tool_calls") and msg.tool_calls:
                    msg_dict["tool_calls"] = msg.tool_calls
                result.append(msg_dict)
            elif isinstance(msg, ToolMessage):
                result.append(
                    {
                        "role": "tool",
                        "content": msg.content,
                        "tool_call_id": msg.tool_call_id,
                        "name": msg.name,
                    }
                )

        return result

    @staticmethod
    def build_messages(
        history: list[dict[str, Any]],
        current_message: str | dict[str, Any],
        system_prompt: str = "",
    ) -> list[dict[str, Any]]:
        """
        Build a complete message list from history, current message, and system prompt.

        This method combines:
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

        # Add system prompt if provided
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        # Add history
        messages.extend(history)

        # Add current user message
        if isinstance(current_message, dict):
            # Vision or complex message
            if current_message.get("type") == "vision":
                messages.append(MessageConverter.build_vision_message(current_message))
            else:
                # Already formatted message dict
                messages.append(current_message)
        else:
            # Simple text message
            messages.append({"role": "user", "content": current_message})

        return messages

    @staticmethod
    def build_vision_message(vision_data: dict[str, Any]) -> dict[str, Any]:
        """
        Build a vision message from vision data.

        Args:
            vision_data: Dict containing:
                - text: Text portion of the message
                - image_base64: Base64-encoded image data
                - mime_type: Image MIME type (e.g., "image/png")

        Returns:
            OpenAI-format vision message dict
        """
        text = vision_data.get("text", "")
        image_base64 = vision_data.get("image_base64", "")
        mime_type = vision_data.get("mime_type", "image/png")

        content = [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{image_base64}"},
            },
        ]

        return {"role": "user", "content": content}

    @staticmethod
    def build_user_message_with_prefix(
        content: str,
        username: str | None = None,
    ) -> dict[str, Any]:
        """
        Build a user message with optional username prefix (for group chat).

        Args:
            content: Message content
            username: Optional username to prefix

        Returns:
            User message dict
        """
        if username:
            formatted_content = f"User[{username}]: {content}"
        else:
            formatted_content = content

        return {"role": "user", "content": formatted_content}

    @staticmethod
    def extract_text_from_message(message: dict[str, Any] | str) -> str:
        """
        Extract text content from a message.

        Handles both simple text messages and vision messages.

        Args:
            message: Message dict or string

        Returns:
            Text content of the message
        """
        if isinstance(message, str):
            return message

        content = message.get("content", "")

        if isinstance(content, str):
            return content

        # Handle list content (vision messages)
        if isinstance(content, list):
            text_parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(part.get("text", ""))
            return " ".join(text_parts)

        return str(content)

    @staticmethod
    def is_vision_message(message: dict[str, Any]) -> bool:
        """
        Check if a message contains vision/image content.

        Args:
            message: Message dict

        Returns:
            True if message contains image content
        """
        content = message.get("content", "")

        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True

        return False

    @staticmethod
    def create_image_content_block(
        image_data: bytes,
        mime_type: str = "image/png",
    ) -> dict[str, Any]:
        """
        Create an image content block from raw bytes.

        Args:
            image_data: Raw image bytes
            mime_type: Image MIME type

        Returns:
            Image content block for vision messages
        """
        encoded = base64.b64encode(image_data).decode("utf-8")
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{encoded}"},
        }
