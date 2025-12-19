"""Base LLM provider interface."""

from abc import ABC, abstractmethod
from typing import AsyncIterator, List, Dict, Any, Optional
from pydantic import BaseModel


class Message(BaseModel):
    """Chat message."""

    role: str  # system, user, assistant, tool
    content: str | List[Dict[str, Any]]  # text or multimodal content
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class StreamChunk(BaseModel):
    """Stream response chunk."""

    delta: Dict[str, Any]
    finish_reason: Optional[str] = None
    usage: Optional[Dict[str, int]] = None


class CompletionResponse(BaseModel):
    """Complete response."""

    content: str
    tool_calls: Optional[List[Dict[str, Any]]] = None
    finish_reason: str
    usage: Dict[str, int]


class BaseLLMProvider(ABC):
    """Base class for LLM providers."""

    def __init__(self, model: str, api_key: str, base_url: Optional[str] = None, **kwargs):
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
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
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
    def convert_to_provider_format(self, messages: List[Message]) -> List[Dict[str, Any]]:
        """Convert messages to provider-specific format.

        Args:
            messages: Standard messages

        Returns:
            Provider-specific message format
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
