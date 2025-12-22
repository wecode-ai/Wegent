# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base LLM provider interface."""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel


class Message(BaseModel):
    """Chat message."""

    role: str  # system, user, assistant, tool
    content: str | list[dict[str, Any]]  # text or multimodal content
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class StreamChunk(BaseModel):
    """Stream response chunk."""

    delta: dict[str, Any]
    finish_reason: str | None = None
    usage: dict[str, int] | None = None


class CompletionResponse(BaseModel):
    """Complete response."""

    content: str
    tool_calls: list[dict[str, Any]] | None = None
    finish_reason: str
    usage: dict[str, int]


class BaseLLMProvider(ABC):
    """Base class for LLM providers."""

    def __init__(self, model: str, api_key: str, base_url: str | None = None, **kwargs):
        """Initialize provider.

        Args:
            model: Model identifier
            api_key: API key
            base_url: Optional base URL for API
            **kwargs: Additional provider-specific parameters
        """
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.kwargs = kwargs

    @abstractmethod
    async def chat_completion(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str = "auto",
        stream: bool = False,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute chat completion.

        Args:
            messages: Conversation messages
            tools: Available tools
            tool_choice: Tool selection strategy (auto, required, none)
            stream: Whether to stream response
            **kwargs: Additional parameters

        Returns:
            CompletionResponse or AsyncIterator[StreamChunk]
        """
        pass

    @abstractmethod
    def convert_to_provider_format(
        self, messages: list[Message]
    ) -> list[dict[str, Any]] | tuple[str | None, list[dict[str, Any]]]:
        """Convert messages to provider-specific format.

        Args:
            messages: Standard messages

        Returns:
            Provider-specific message format. Can be either:
            - list[dict[str, Any]]: Simple message list
            - tuple[str | None, list[dict[str, Any]]]: (system_message, messages)
        """
        pass

    @abstractmethod
    def convert_from_provider_format(self, response: Any) -> CompletionResponse:
        """Convert provider response to standard format.

        Args:
            response: Provider-specific response

        Returns:
            Standard CompletionResponse
        """
        pass
