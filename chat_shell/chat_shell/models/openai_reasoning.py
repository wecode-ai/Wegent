# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ChatOpenAI subclass that captures reasoning_content from OpenAI-compatible APIs.

Some OpenAI-compatible providers (e.g. Kimi, DeepSeek) return a non-standard
``reasoning_content`` field in streaming deltas. The default ChatOpenAI drops
this field during chunk conversion. This module provides a thin subclass that
post-processes each chunk to preserve reasoning_content in
``additional_kwargs``, making it available to downstream consumers like
graph_builder's ``stream_tokens``.

Usage:
    Use ``ChatOpenAIWithReasoning`` as a drop-in replacement for ``ChatOpenAI``
    when think_config is present for OpenAI-compatible providers.
"""

import logging
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_openai import ChatOpenAI
from langchain_openai.chat_models.base import ChatGenerationChunk

logger = logging.getLogger(__name__)


class ChatOpenAIWithReasoning(ChatOpenAI):
    """ChatOpenAI variant that extracts reasoning_content from streaming deltas.

    Overrides ``_convert_chunk_to_generation_chunk`` to capture the
    ``reasoning_content`` field from the raw API response delta and inject it
    into the AIMessageChunk's ``additional_kwargs``.  All other behavior is
    identical to the base ``ChatOpenAI``.
    """

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> ChatGenerationChunk | None:
        generation_chunk = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation_chunk is None:
            return None

        # Extract reasoning_content from the raw delta
        choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices") or []
        if choices:
            delta = choices[0].get("delta") or {}
            reasoning_content = delta.get("reasoning_content")
            if reasoning_content and isinstance(
                generation_chunk.message, AIMessageChunk
            ):
                generation_chunk.message.additional_kwargs["reasoning_content"] = (
                    reasoning_content
                )

        return generation_chunk

    def _get_request_payload(
        self,
        input_: Any,
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> dict:
        """Override to inject reasoning_content into assistant messages.

        LangChain's ``_convert_message_to_dict`` drops ``reasoning_content``
        from ``additional_kwargs``.  For OpenAI-compatible APIs with thinking
        enabled (e.g., Kimi, DeepSeek), ``reasoning_content`` must be present
        in assistant messages in the conversation history, otherwise the API
        returns a 400 error.

        Handles two data formats:
        - **Legacy**: ``reasoning_content`` in ``additional_kwargs``
        - **Canonical**: ``{"type": "reasoning", "reasoning": "..."}`` blocks
          in the message content list (written by normalized serialization)
        """
        # Capture original LangChain messages before they are converted
        lc_messages = self._convert_input(input_).to_messages()

        # Build the standard payload via parent
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)

        # Post-process: inject reasoning_content into assistant message dicts.
        # The payload messages are in 1:1 correspondence with lc_messages.
        payload_messages = payload.get("messages")
        if payload_messages and len(payload_messages) == len(lc_messages):
            for lc_msg, api_msg in zip(lc_messages, payload_messages):
                if not (
                    isinstance(lc_msg, AIMessage) and api_msg.get("role") == "assistant"
                ):
                    continue

                # Path 1: Legacy format — reasoning_content in additional_kwargs
                reasoning = lc_msg.additional_kwargs.get("reasoning_content")
                if reasoning is not None:
                    api_msg["reasoning_content"] = reasoning
                    continue

                # Path 2: Canonical format — reasoning blocks in content list.
                # NOTE: We must read from the *original* LangChain message
                # because LangChain's _convert_from_v1_to_chat_completions
                # strips reasoning blocks from the payload content before
                # our override runs.
                lc_content = lc_msg.content
                if not isinstance(lc_content, list):
                    continue

                reasoning_texts: list[str] = []
                for block in lc_content:
                    if isinstance(block, dict) and block.get("type") == "reasoning":
                        text = block.get("reasoning", "")
                        if text:
                            reasoning_texts.append(text)

                if reasoning_texts:
                    api_msg["reasoning_content"] = "\n".join(reasoning_texts)
                    # Clean up content: remove any stray reasoning blocks
                    # that survived conversion (shouldn't happen, but be safe).
                    api_content = api_msg.get("content")
                    if isinstance(api_content, list):
                        non_reasoning = [
                            b
                            for b in api_content
                            if not (
                                isinstance(b, dict)
                                and b.get("type") == "reasoning"
                            )
                        ]
                        if (
                            len(non_reasoning) == 1
                            and non_reasoning[0].get("type") == "text"
                        ):
                            api_msg["content"] = non_reasoning[0]["text"]
                        elif non_reasoning:
                            api_msg["content"] = non_reasoning
                        elif not non_reasoning:
                            api_msg["content"] = ""

        return payload
