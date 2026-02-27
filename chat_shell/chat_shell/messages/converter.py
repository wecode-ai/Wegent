# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message converter utilities for LangGraph Chat Service."""

import base64
import io
import logging
from datetime import datetime
from typing import Any

from PIL import Image

logger = logging.getLogger(__name__)

# Maximum image size: 1MB (hard limit after compression)
MAX_IMAGE_SIZE_MB = 1
MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024


class MessageConverter:
    """Utilities for building and converting messages.

    Note: For converting OpenAI-style dicts to LangChain messages,
    use langchain_core.messages.utils.convert_to_messages directly.
    """

    @staticmethod
    def build_messages(
        history: list[dict[str, Any]],
        current_message: str | list[dict[str, Any]],
        system_prompt: str = "",
        username: str | None = None,
        inject_datetime: bool = True,
        dynamic_context: str | None = None,
    ) -> list[dict[str, Any]]:
        """Build a complete message list from history, current message, and system prompt.

        Combines:
        - System prompt (if provided)
        - Chat history
        - Dynamic context (if provided, injected as a human message)
        - Current user message (with optional datetime context at the END)

        The datetime is injected at the END of the user message (not system prompt) to enable
        prompt caching. This allows:
        1. System prompts to remain static and be cached
        2. User message prefix to be cached (prefix matching)
        3. Only the datetime suffix changes between requests

        The dynamic_context is injected as a human message before the current user message to
        keep system prompts static and improve cache hit rate.

        Args:
            history: Previous messages in the conversation
            current_message: The current user message. Can be:
                - string: Plain text message
                - list[dict]: OpenAI Responses API format content blocks
                  [{"type": "input_text", "text": "..."}, {"type": "input_image", "image_url": "data:..."}]
            system_prompt: Optional system prompt to prepend
            username: Optional username to prefix the current message (for group chat)
            inject_datetime: Whether to inject current datetime into user message (default: True)
            dynamic_context: Optional dynamic context to inject before current message

        Returns:
            List of message dicts ready for LLM API (LangChain/OpenAI Chat Completions format)
        """
        messages: list[dict[str, Any]] = []

        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        messages.extend(history)

        if dynamic_context:
            messages.append({"role": "user", "content": dynamic_context})

        # Build datetime context suffix for user message (at the END for better caching)
        # Placing at the end allows the message prefix to be cached via prefix matching
        time_suffix = ""
        if inject_datetime:
            now = datetime.now()
            time_suffix = f"\n[Current time: {now.strftime('%Y-%m-%d %H:%M')}]"

        if isinstance(current_message, list):
            # OpenAI Responses API format: list of content blocks
            # [{"type": "input_text", "text": "..."}, {"type": "input_image", "image_url": "data:..."}]
            # Convert to LangChain/OpenAI Chat Completions format
            messages.append(
                MessageConverter._convert_responses_api_to_langchain(
                    current_message, username, time_suffix
                )
            )
        else:
            # Plain text message
            content = (
                f"User[{username}]: {current_message}" if username else current_message
            )
            content = content + time_suffix
            messages.append({"role": "user", "content": content})

        return messages

    @staticmethod
    def _convert_responses_api_to_langchain(
        content_blocks: list[dict[str, Any]],
        username: str | None = None,
        time_suffix: str = "",
    ) -> dict[str, Any]:
        """Convert OpenAI Responses API format to LangChain/Chat Completions format.

        OpenAI Responses API format:
        [
            {"type": "input_text", "text": "..."},
            {"type": "input_image", "image_url": "data:image/png;base64,..."},
        ]

        LangChain/Chat Completions format:
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "..."},
                {"type": "image_url", "image_url": {"url": "data:..."}},
            ]
        }

        Args:
            content_blocks: List of content blocks in Responses API format
            username: Optional username to prefix text content
            time_suffix: Optional time suffix to append to text content

        Returns:
            Message dict in LangChain/Chat Completions format
        """
        langchain_content: list[dict[str, Any]] = []
        first_text_processed = False

        for block in content_blocks:
            block_type = block.get("type", "")

            if block_type == "input_text":
                # Convert input_text to text
                text = block.get("text", "")
                if not first_text_processed:
                    if username:
                        text = f"User[{username}]: {text}"
                    text = text + time_suffix
                    first_text_processed = True
                langchain_content.append({"type": "text", "text": text})

            elif block_type == "input_image":
                # Convert input_image to image_url
                image_url = block.get("image_url", "")
                if image_url:
                    # Compress image if needed
                    try:
                        # Extract base64 data from data URL
                        if image_url.startswith("data:"):
                            # Parse data URL: data:image/png;base64,<base64_data>
                            header, base64_data = image_url.split(",", 1)
                            mime_type = header.split(":")[1].split(";")[0]

                            image_bytes = base64.b64decode(base64_data)
                            if len(image_bytes) > MAX_IMAGE_SIZE_BYTES:
                                compressed_bytes = MessageConverter._compress_image(
                                    image_bytes, mime_type
                                )
                                compressed_base64 = base64.b64encode(
                                    compressed_bytes
                                ).decode("utf-8")
                                image_url = (
                                    f"data:{mime_type};base64,{compressed_base64}"
                                )
                    except Exception as e:
                        logger.warning(f"Failed to process image: {e}")

                    langchain_content.append(
                        {"type": "image_url", "image_url": {"url": image_url}}
                    )

        return {"role": "user", "content": langchain_content}

    @staticmethod
    def _compress_image(image_data: bytes, mime_type: str = "image/png") -> bytes:
        """Compress image if it exceeds the size limit."""
        original_size = len(image_data)
        if original_size <= MAX_IMAGE_SIZE_BYTES:
            logger.debug(
                f"Image size {original_size / 1024 / 1024:.2f}MB is within limit {MAX_IMAGE_SIZE_MB}MB, skipping compression"
            )
            return image_data

        logger.info(
            f"Image size {original_size / 1024 / 1024:.2f}MB exceeds limit {MAX_IMAGE_SIZE_MB}MB, compressing..."
        )

        try:
            # Convert mime_type to PIL format
            fmt = mime_type.split("/")[-1].upper()
            if fmt == "JPG":
                fmt = "JPEG"

            img = Image.open(io.BytesIO(image_data))

            # Convert to RGB if necessary (e.g. for JPEG)
            if fmt == "JPEG" and img.mode != "RGB":
                img = img.convert("RGB")

            # Initial quality
            quality = 85
            output = io.BytesIO()

            while quality > 10:
                output.seek(0)
                output.truncate()

                if fmt in ("JPEG", "WEBP"):
                    img.save(output, format=fmt, quality=quality)
                else:
                    # For PNG and others, quality param is ignored, try optimize
                    img.save(output, format=fmt, optimize=True)

                compressed_data = output.getvalue()

                if len(compressed_data) <= MAX_IMAGE_SIZE_BYTES:
                    logger.info(
                        f"Image compressed (quality reduction): {original_size / 1024 / 1024:.2f}MB -> {len(compressed_data) / 1024 / 1024:.2f}MB "
                        f"(ratio: {len(compressed_data) / original_size:.2%})"
                    )
                    return compressed_data

                quality -= 10

                # For non-quality formats (like PNG), quality loop is ineffective
                # so we break after first attempt (with optimize=True) and move to resizing
                if fmt not in ("JPEG", "WEBP"):
                    break

            # If still too big, resize
            width, height = img.size
            ratio = 0.8
            while len(compressed_data) > MAX_IMAGE_SIZE_BYTES and width > 100:
                width = int(width * ratio)
                height = int(height * ratio)
                img = img.resize((width, height), Image.Resampling.LANCZOS)

                output.seek(0)
                output.truncate()

                if fmt in ("JPEG", "WEBP"):
                    img.save(output, format=fmt, quality=quality)
                else:
                    img.save(output, format=fmt, optimize=True)

                compressed_data = output.getvalue()

            final_size = len(compressed_data)
            logger.info(
                f"Image compressed: {original_size / 1024 / 1024:.2f}MB -> {final_size / 1024 / 1024:.2f}MB "
                f"(ratio: {final_size / original_size:.2%})"
            )
            return compressed_data

        except Exception as e:
            logger.warning(f"Image compression failed: {e}")
            # If compression fails, return original data
            return image_data

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
        if len(image_data) > MAX_IMAGE_SIZE_BYTES:
            image_data = MessageConverter._compress_image(image_data, mime_type)

        encoded = base64.b64encode(image_data).decode("utf-8")
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{encoded}"},
        }
