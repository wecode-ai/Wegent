"""OpenAI provider implementation."""

from typing import AsyncIterator, List, Dict, Any, Optional
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletion, ChatCompletionChunk

from .base import BaseLLMProvider, Message, StreamChunk, CompletionResponse


class OpenAIProvider(BaseLLMProvider):
    """OpenAI LLM provider using official SDK."""

    def __init__(self, model: str, api_key: str, base_url: Optional[str] = None, **kwargs):
        """Initialize OpenAI provider.

        Args:
            model: Model name (e.g., gpt-4o, gpt-4-turbo)
            api_key: OpenAI API key
            base_url: Optional custom base URL
            **kwargs: Additional parameters
        """
        super().__init__(model, api_key, base_url, **kwargs)
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def chat_completion(
        self,
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: str = "auto",
        stream: bool = False,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute OpenAI chat completion."""
        provider_messages = self.convert_to_provider_format(messages)

        params = {
            "model": self.model,
            "messages": provider_messages,
            "stream": stream,
            **kwargs,
        }

        if tools:
            params["tools"] = tools
            params["tool_choice"] = tool_choice

        if stream:
            return self._stream_completion(params)
        else:
            response = await self.client.chat.completions.create(**params)
            return self.convert_from_provider_format(response)

    async def _stream_completion(self, params: Dict[str, Any]) -> AsyncIterator[StreamChunk]:
        """Stream completion responses."""
        async for chunk in await self.client.chat.completions.create(**params):
            yield self._convert_stream_chunk(chunk)

    def convert_to_provider_format(self, messages: List[Message]) -> List[Dict[str, Any]]:
        """Convert messages to OpenAI format."""
        provider_messages = []
        for msg in messages:
            message_dict = {"role": msg.role, "content": msg.content}

            if msg.name:
                message_dict["name"] = msg.name

            if msg.tool_calls:
                message_dict["tool_calls"] = msg.tool_calls

            if msg.tool_call_id:
                message_dict["tool_call_id"] = msg.tool_call_id

            provider_messages.append(message_dict)

        return provider_messages

    def convert_from_provider_format(self, response: ChatCompletion) -> CompletionResponse:
        """Convert OpenAI response to standard format."""
        choice = response.choices[0]
        message = choice.message

        return CompletionResponse(
            content=message.content or "",
            tool_calls=[tc.model_dump() for tc in message.tool_calls] if message.tool_calls else None,
            finish_reason=choice.finish_reason or "stop",
            usage={
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            },
        )

    def _convert_stream_chunk(self, chunk: ChatCompletionChunk) -> StreamChunk:
        """Convert OpenAI stream chunk to standard format."""
        choice = chunk.choices[0] if chunk.choices else None

        delta = {}
        if choice and choice.delta:
            if choice.delta.content:
                delta["content"] = choice.delta.content
            if choice.delta.tool_calls:
                delta["tool_calls"] = [tc.model_dump() for tc in choice.delta.tool_calls]

        return StreamChunk(
            delta=delta,
            finish_reason=choice.finish_reason if choice else None,
            usage=chunk.usage.model_dump() if chunk.usage else None,
        )
