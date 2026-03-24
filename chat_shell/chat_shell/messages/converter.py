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

        Note: Anthropic explicit cache breakpoints should be applied AFTER
        message compression via ``apply_cache_breakpoints()``, not here.

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

        # Build raw datetime text (without wrapper).  The wrapper is applied
        # later by _build_system_reminder_block.
        time_text: str | None = None
        if inject_datetime:
            now = datetime.now()
            time_text = f"<CurrentTime>{now.strftime('%Y-%m-%d %H:%M')}</CurrentTime>"

        if isinstance(current_message, list):
            # OpenAI Responses API format: list of content blocks
            # [{"type": "input_text", "text": "..."}, {"type": "input_image", ...}]
            # Convert to LangChain/OpenAI Chat Completions format.
            # Context text blocks (attachment metadata, etc.) are kept as
            # independent blocks; only time_text goes into <system-reminder>.
            messages.append(
                MessageConverter._convert_responses_api_to_langchain(
                    current_message, username, time_text
                )
            )
        else:
            # Plain text message
            user_text = (
                f"User[{username}]: {current_message}" if username else current_message
            )
            reminder = MessageConverter._build_system_reminder_block(time_text)
            if reminder:
                messages.append(
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": user_text}, reminder],
                    }
                )
            else:
                messages.append({"role": "user", "content": user_text})

        return messages

    # ------------------------------------------------------------------
    # Anthropic explicit cache breakpoints
    # ------------------------------------------------------------------

    # Anthropic's explicit cache_control marker.
    _CACHE_CONTROL = {"type": "ephemeral"}

    @staticmethod
    def apply_cache_breakpoints(
        messages: list[dict[str, Any]],
        *,
        has_history: bool,
        has_dynamic_context: bool,
    ) -> None:
        """Add Anthropic cache_control breakpoints to stable message blocks.

        Breakpoints are placed on the *last* content block of each stable
        message so that Anthropic caches the entire prefix up to that point.

        Placement strategy (up to 4 breakpoints allowed by the API):
        1. **System prompt** — rarely changes; always worth caching.
        2. **Last history message** — the conversation prefix is stable;
           new turns only append, so the cached prefix keeps hitting.
        3. **Dynamic context** — KB / RAG content is stable within a session.

        The current user message is *not* marked because it changes every turn.
        """
        cc = MessageConverter._CACHE_CONTROL

        # Helper: index of the *last* message with a given role before `before_idx`
        def _last_index(role: str, before_idx: int) -> int | None:
            for i in range(before_idx - 1, -1, -1):
                if messages[i].get("role") == role:
                    return i
            return None

        # The current user message is always the last element.
        current_idx = len(messages)

        # 1. System prompt (first message if role==system)
        if messages and messages[0].get("role") == "system":
            MessageConverter._set_cache_control_on_message(messages, 0, cc)

        # 2. Last history message (the message just before dynamic_context or
        #    current user message — whichever comes first)
        if has_history:
            # Dynamic context is inserted as a user message right before the
            # current user message, so last history msg is at current_idx - 2
            # when dynamic context is present, or current_idx - 1 otherwise,
            # but we must skip back past the dynamic-context entry.
            search_end = current_idx - 1 if has_dynamic_context else current_idx
            hist_idx = _last_index("assistant", search_end)
            if hist_idx is None:
                hist_idx = _last_index("user", search_end)
            if hist_idx is not None:
                MessageConverter._set_cache_control_on_message(messages, hist_idx, cc)

        # 3. Dynamic context message (right before the current user message)
        if has_dynamic_context and len(messages) >= 2:
            dc_idx = len(messages) - 2
            MessageConverter._set_cache_control_on_message(messages, dc_idx, cc)

    @staticmethod
    def _set_cache_control_on_message(
        messages: list[dict[str, Any]],
        idx: int,
        cache_control: dict[str, str],
    ) -> None:
        """Set cache_control on the last content block of ``messages[idx]``."""
        msg = messages[idx]
        content = msg.get("content")
        if content is None:
            return
        if isinstance(content, str):
            # Convert to block format so we can attach metadata.
            msg["content"] = [
                {"type": "text", "text": content, "cache_control": cache_control}
            ]
        elif isinstance(content, list) and content:
            last_block = content[-1]
            if isinstance(last_block, dict):
                last_block["cache_control"] = cache_control

    @staticmethod
    def _build_system_reminder_block(
        time_text: str | None = None,
    ) -> dict[str, Any] | None:
        """Build a ``<system-reminder>`` content block for ephemeral metadata.

        Only contains small, non-persisted metadata like ``<CurrentTime>``.
        Context content (attachments, knowledge base, selected documents)
        is kept as independent text blocks — not merged here.

        Args:
            time_text: Optional raw time string (e.g. ``<CurrentTime>...</CurrentTime>``).

        Returns:
            A ``{"type": "text", "text": "<system-reminder>...</system-reminder>"}``
            dict, or ``None`` if there is nothing to include.
        """
        if not time_text:
            return None
        return {
            "type": "text",
            "text": f"<system-reminder>{time_text}</system-reminder>",
        }

    @staticmethod
    def _convert_responses_api_to_langchain(
        content_blocks: list[dict[str, Any]],
        username: str | None = None,
        time_text: str | None = None,
    ) -> dict[str, Any]:
        """Convert OpenAI Responses API format to LangChain/Chat Completions format.

        Context text blocks (attachment metadata, selected-documents, etc.) are
        kept as **independent** text blocks.  Only ``time_text`` is wrapped in
        a ``<system-reminder>`` block appended at the end.  The last
        ``input_text`` block is always treated as the user's own message.

        Args:
            content_blocks: List of content blocks in Responses API format
            username: Optional username to prefix text content
            time_text: Optional raw time string for ``<system-reminder>``

        Returns:
            Message dict in LangChain/Chat Completions format
        """
        # Phase 1 — convert blocks, separating text vs image
        text_entries: list[dict[str, Any]] = []  # (converted text blocks)
        image_entries: list[dict[str, Any]] = []  # (converted image blocks)

        for block in content_blocks:
            block_type = block.get("type", "")

            if block_type == "input_text":
                text_entries.append({"type": "text", "text": block.get("text", "")})

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

                    image_entries.append(
                        {"type": "image_url", "image_url": {"url": image_url}}
                    )

        # Phase 2 — separate user message (last text) from context blocks
        if text_entries:
            user_msg_block = text_entries[-1]
            context_blocks = text_entries[:-1]  # independent text blocks
        else:
            # Image-only message: create an empty text block for username
            user_msg_block = {"type": "text", "text": ""}
            context_blocks = []

        # Apply username prefix to the user message block
        if username:
            user_msg_block["text"] = f"User[{username}]: {user_msg_block['text']}"

        # Phase 3 — assemble: [user_msg, images, context_blocks..., system-reminder]
        langchain_content: list[dict[str, Any]] = [user_msg_block]
        langchain_content.extend(image_entries)
        langchain_content.extend(context_blocks)

        reminder = MessageConverter._build_system_reminder_block(time_text)
        if reminder:
            langchain_content.append(reminder)

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
