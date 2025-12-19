"""Anthropic provider implementation."""

from typing import AsyncIterator, List, Dict, Any, Optional
from anthropic import AsyncAnthropic
from anthropic.types import Message as AnthropicMessage, ContentBlock, ToolUseBlock

from .base import BaseLLMProvider, Message, StreamChunk, CompletionResponse


class AnthropicProvider(BaseLLMProvider):
    """Anthropic LLM provider using official SDK."""

    def __init__(self, model: str, api_key: str, base_url: Optional[str] = None, **kwargs):
        """Initialize Anthropic provider.

        Args:
            model: Model name (e.g., claude-3-5-sonnet-20241022)
            api_key: Anthropic API key
            base_url: Optional custom base URL
            **kwargs: Additional parameters
        """
        super().__init__(model, api_key, base_url, **kwargs)
        self.client = AsyncAnthropic(api_key=api_key, base_url=base_url)

    async def chat_completion(
        self,
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: str = "auto",
        stream: bool = False,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute Anthropic chat completion."""
        system_message, provider_messages = self.convert_to_provider_format(messages)

        params = {
            "model": self.model,
            "messages": provider_messages,
            "max_tokens": kwargs.get("max_tokens", 4096),
            "stream": stream,
        }

        if system_message:
            params["system"] = system_message

        if tools:
            params["tools"] = self._convert_tools_to_anthropic_format(tools)
            if tool_choice == "required":
                params["tool_choice"] = {"type": "any"}
            elif tool_choice != "auto":
                params["tool_choice"] = {"type": "tool", "name": tool_choice}

        if stream:
            return self._stream_completion(params)
        else:
            response = await self.client.messages.create(**params)
            return self.convert_from_provider_format(response)

    async def _stream_completion(self, params: Dict[str, Any]) -> AsyncIterator[StreamChunk]:
        """Stream completion responses."""
        async with self.client.messages.stream(**params) as stream:
            async for chunk in stream:
                yield self._convert_stream_chunk(chunk)

    def convert_to_provider_format(self, messages: List[Message]) -> tuple[str | None, List[Dict[str, Any]]]:
        """Convert messages to Anthropic format.

        Returns:
            Tuple of (system_message, user_messages)
        """
        system_message = None
        provider_messages = []

        for msg in messages:
            if msg.role == "system":
                system_message = msg.content if isinstance(msg.content, str) else ""
            else:
                # Convert role
                role = msg.role
                if role == "assistant" and msg.tool_call_id:
                    role = "user"  # Tool results are user messages in Anthropic

                message_dict = {"role": role}

                # Convert content
                if isinstance(msg.content, str):
                    message_dict["content"] = msg.content
                elif isinstance(msg.content, list):
                    message_dict["content"] = self._convert_multimodal_content(msg.content)

                # Convert tool calls
                if msg.tool_calls:
                    message_dict["content"] = [
                        {
                            "type": "tool_use",
                            "id": tc["id"],
                            "name": tc["function"]["name"],
                            "input": tc["function"]["arguments"],
                        }
                        for tc in msg.tool_calls
                    ]

                # Convert tool results
                if msg.tool_call_id:
                    message_dict["content"] = [
                        {
                            "type": "tool_result",
                            "tool_use_id": msg.tool_call_id,
                            "content": msg.content,
                        }
                    ]

                provider_messages.append(message_dict)

        return system_message, provider_messages

    def convert_from_provider_format(self, response: AnthropicMessage) -> CompletionResponse:
        """Convert Anthropic response to standard format."""
        content = ""
        tool_calls = []

        for block in response.content:
            if block.type == "text":
                content += block.text
            elif block.type == "tool_use":
                tool_calls.append(
                    {
                        "id": block.id,
                        "type": "function",
                        "function": {
                            "name": block.name,
                            "arguments": block.input,
                        },
                    }
                )

        return CompletionResponse(
            content=content,
            tool_calls=tool_calls if tool_calls else None,
            finish_reason=response.stop_reason or "stop",
            usage={
                "prompt_tokens": response.usage.input_tokens,
                "completion_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        )

    def _convert_stream_chunk(self, chunk: Any) -> StreamChunk:
        """Convert Anthropic stream chunk to standard format."""
        delta = {}
        finish_reason = None

        if hasattr(chunk, "type"):
            if chunk.type == "content_block_delta":
                if hasattr(chunk.delta, "text"):
                    delta["content"] = chunk.delta.text
            elif chunk.type == "message_stop":
                finish_reason = "stop"

        return StreamChunk(delta=delta, finish_reason=finish_reason)

    def _convert_tools_to_anthropic_format(self, tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert OpenAI-style tools to Anthropic format."""
        anthropic_tools = []
        for tool in tools:
            if tool["type"] == "function":
                func = tool["function"]
                anthropic_tools.append(
                    {
                        "name": func["name"],
                        "description": func.get("description", ""),
                        "input_schema": func.get("parameters", {}),
                    }
                )
        return anthropic_tools

    def _convert_multimodal_content(self, content: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert OpenAI-style multimodal content to Anthropic format."""
        anthropic_content = []
        for item in content:
            if item["type"] == "text":
                anthropic_content.append({"type": "text", "text": item["text"]})
            elif item["type"] == "image_url":
                # Anthropic uses base64 image format
                image_url = item["image_url"]["url"]
                if image_url.startswith("data:"):
                    # Extract base64 data
                    media_type, base64_data = image_url.split(";base64,")
                    media_type = media_type.replace("data:", "")
                    anthropic_content.append(
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": base64_data,
                            },
                        }
                    )
        return anthropic_content
