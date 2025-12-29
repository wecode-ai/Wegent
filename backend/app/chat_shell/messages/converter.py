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
        current_message: str | dict[str, Any],
        system_prompt: str = "",
        username: str | None = None,
        inject_datetime: bool = True,
    ) -> list[dict[str, Any]]:
        """Build a complete message list from history, current message, and system prompt.

        Combines:
        - System prompt (if provided)
        - Chat history
        - Current user message (with optional datetime context at the END)

        The datetime is injected at the END of the user message (not system prompt) to enable
        prompt caching. This allows:
        1. System prompts to remain static and be cached
        2. User message prefix to be cached (prefix matching)
        3. Only the datetime suffix changes between requests

        Args:
            history: Previous messages in the conversation
            current_message: The current user message (string or vision dict)
            system_prompt: Optional system prompt to prepend
            username: Optional username to prefix the current message (for group chat)
            inject_datetime: Whether to inject current datetime into user message (default: True)

        Returns:
            List of message dicts ready for LLM API
        """
        messages: list[dict[str, Any]] = []

        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        messages.extend(history)

        # Build datetime context suffix for user message (at the END for better caching)
        # Placing at the end allows the message prefix to be cached via prefix matching
        time_suffix = ""
        if inject_datetime:
            now = datetime.now()
            time_suffix = f"\n[Current time: {now.strftime('%Y-%m-%d %H:%M')}]"

        if isinstance(current_message, dict):
            if current_message.get("type") == "vision":
                # For vision messages, add username prefix and time suffix to text
                vision_data = current_message.copy()
                text = vision_data.get("text", "")
                if username:
                    text = f"User[{username}]: {text}"
                vision_data["text"] = text + time_suffix
                messages.append(MessageConverter._build_vision_from_dict(vision_data))
            elif current_message.get("type") == "multi_vision":
                # For multi-vision messages, add username prefix and time suffix to text
                multi_vision_data = current_message.copy()
                text = multi_vision_data.get("text", "")
                if username:
                    text = f"User[{username}]: {text}"
                multi_vision_data["text"] = text + time_suffix
                messages.append(
                    MessageConverter._build_multi_vision_from_dict(multi_vision_data)
                )
            else:
                messages.append(current_message)
        else:
            # For plain text messages, add username prefix and time suffix
            content = (
                f"User[{username}]: {current_message}" if username else current_message
            )
            content = content + time_suffix
            messages.append({"role": "user", "content": content})

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
    def _build_multi_vision_from_dict(
        multi_vision_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Build multi-vision message from a multi-vision data dict with multiple images."""
        text = multi_vision_data.get("text", "")
        images = multi_vision_data.get("images", [])

        # Build content array with text and all images
        content = [{"type": "text", "text": text}]

        for image_data in images:
            image_base64 = image_data.get("image_base64", "")
            mime_type = image_data.get("mime_type", "image/png")

            # Compress image if needed
            try:
                image_bytes = base64.b64decode(image_base64)
                compressed_bytes = MessageConverter._compress_image(
                    image_bytes, mime_type
                )
                compressed_base64 = base64.b64encode(compressed_bytes).decode("utf-8")

                content.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{compressed_base64}"
                        },
                    }
                )
            except Exception as e:
                logger.error(f"Failed to process image: {e}")
                continue

        return {"role": "user", "content": content}

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
    def build_vision_message(
        text: str = "",
        image_base64: str = "",
        mime_type: str = "image/png",
    ) -> dict[str, Any]:
        """Build a vision message with text and image."""
        if image_base64:
            # Decode, compress, then re-encode
            try:
                image_data = base64.b64decode(image_base64)
                if len(image_data) > MAX_IMAGE_SIZE_BYTES:
                    compressed_data = MessageConverter._compress_image(
                        image_data, mime_type
                    )
                    image_base64 = base64.b64encode(compressed_data).decode("utf-8")
            except Exception:
                # If decoding/compression fails, proceed with original (might fail later)
                logger.exception("Failed to process image data in build_vision_message")

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
        if len(image_data) > MAX_IMAGE_SIZE_BYTES:
            image_data = MessageConverter._compress_image(image_data, mime_type)

        encoded = base64.b64encode(image_data).decode("utf-8")
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{encoded}"},
        }
