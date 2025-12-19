"""Google Gemini provider implementation."""

import json
from typing import Any, AsyncIterator, Dict, List, Optional
from uuid import uuid4

import google.generativeai as genai
from google.generativeai.types import GenerateContentResponse

from .base import BaseLLMProvider, CompletionResponse, Message, StreamChunk


class GeminiProvider(BaseLLMProvider):
    """Google Gemini LLM provider using official SDK."""

    def __init__(
        self, model: str, api_key: str, base_url: Optional[str] = None, **kwargs
    ):
        """Initialize Gemini provider.

        Args:
            model: Model name (e.g., gemini-2.0-flash-exp)
            api_key: Google API key
            base_url: Not used for Gemini
            **kwargs: Additional parameters
        """
        super().__init__(model, api_key, base_url, **kwargs)
        genai.configure(api_key=api_key)
        self.model_instance = genai.GenerativeModel(model)

    async def chat_completion(
        self,
        messages: List[Message],
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: str = "auto",
        stream: bool = False,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute Gemini chat completion."""
        system_instruction, provider_messages = self.convert_to_provider_format(
            messages
        )

        # Configure model with system instruction if present
        if system_instruction:
            model = genai.GenerativeModel(
                self.model, system_instruction=system_instruction
            )
        else:
            model = self.model_instance

        # Convert tools to Gemini format
        gemini_tools = None
        if tools:
            gemini_tools = self._convert_tools_to_gemini_format(tools)

        # Generate content
        if stream:
            return self._stream_completion(model, provider_messages, gemini_tools)
        else:
            response = await model.generate_content_async(
                provider_messages, tools=gemini_tools
            )
            return self.convert_from_provider_format(response)

    async def _stream_completion(
        self, model: Any, messages: List[Dict[str, Any]], tools: Optional[List[Any]]
    ) -> AsyncIterator[StreamChunk]:
        """Stream completion responses."""
        response = await model.generate_content_async(
            messages, tools=tools, stream=True
        )
        async for chunk in response:
            yield self._convert_stream_chunk(chunk)

    def convert_to_provider_format(
        self, messages: List[Message]
    ) -> tuple[str | None, List[Dict[str, Any]]]:
        """Convert messages to Gemini format.

        Returns:
            Tuple of (system_instruction, conversation_messages)
        """
        system_instruction = None
        provider_messages = []

        for msg in messages:
            if msg.role == "system":
                system_instruction = msg.content if isinstance(msg.content, str) else ""
            else:
                # Convert role: user, model (assistant in Gemini)
                role = "model" if msg.role == "assistant" else "user"

                # Convert content
                parts = []
                if isinstance(msg.content, str):
                    parts.append({"text": msg.content})
                elif isinstance(msg.content, list):
                    parts.extend(self._convert_multimodal_content(msg.content))

                # Handle tool calls
                if msg.tool_calls:
                    for tc in msg.tool_calls:
                        parts.append(
                            {
                                "function_call": {
                                    "name": tc["function"]["name"],
                                    "args": (
                                        json.loads(tc["function"]["arguments"])
                                        if isinstance(tc["function"]["arguments"], str)
                                        else tc["function"]["arguments"]
                                    ),
                                }
                            }
                        )

                # Handle tool results
                if msg.tool_call_id:
                    parts.append(
                        {
                            "function_response": {
                                "name": msg.name or "tool_result",
                                "response": {"result": msg.content},
                            }
                        }
                    )

                provider_messages.append({"role": role, "parts": parts})

        return system_instruction, provider_messages

    def convert_from_provider_format(
        self, response: GenerateContentResponse
    ) -> CompletionResponse:
        """Convert Gemini response to standard format."""
        content = ""
        tool_calls = []

        if response.candidates:
            candidate = response.candidates[0]
            for part in candidate.content.parts:
                if hasattr(part, "text"):
                    content += part.text
                elif hasattr(part, "function_call"):
                    fc = part.function_call
                    tool_calls.append(
                        {
                            "id": f"call_{uuid4()}",  # Generate unique ID per call
                            "type": "function",
                            "function": {
                                "name": fc.name,
                                "arguments": json.dumps(dict(fc.args)),
                            },
                        }
                    )

        return CompletionResponse(
            content=content,
            tool_calls=tool_calls if tool_calls else None,
            finish_reason=(
                response.candidates[0].finish_reason.name
                if response.candidates
                else "stop"
            ),
            usage={
                "prompt_tokens": (
                    response.usage_metadata.prompt_token_count
                    if response.usage_metadata
                    else 0
                ),
                "completion_tokens": (
                    response.usage_metadata.candidates_token_count
                    if response.usage_metadata
                    else 0
                ),
                "total_tokens": (
                    response.usage_metadata.total_token_count
                    if response.usage_metadata
                    else 0
                ),
            },
        )

    def _convert_stream_chunk(self, chunk: GenerateContentResponse) -> StreamChunk:
        """Convert Gemini stream chunk to standard format."""
        delta = {}
        finish_reason = None

        if chunk.candidates:
            candidate = chunk.candidates[0]
            for part in candidate.content.parts:
                if hasattr(part, "text"):
                    delta["content"] = part.text
                elif hasattr(part, "function_call"):
                    fc = part.function_call
                    delta["tool_calls"] = [
                        {
                            "id": f"call_{uuid4()}",  # Generate unique ID per call
                            "type": "function",
                            "function": {
                                "name": fc.name,
                                "arguments": json.dumps(dict(fc.args)),
                            },
                        }
                    ]

            if candidate.finish_reason:
                finish_reason = candidate.finish_reason.name

        return StreamChunk(delta=delta, finish_reason=finish_reason)

    def _convert_tools_to_gemini_format(self, tools: List[Dict[str, Any]]) -> List[Any]:
        """Convert OpenAI-style tools to Gemini format."""
        import google.ai.generativelanguage as glm

        gemini_tools = []
        for tool in tools:
            if tool["type"] == "function":
                func = tool["function"]
                # Convert JSON Schema to Gemini parameter format
                parameters = func.get("parameters", {})
                gemini_func = glm.FunctionDeclaration(
                    name=func["name"],
                    description=func.get("description", ""),
                    parameters=self._convert_json_schema_to_gemini(parameters),
                )
                gemini_tools.append(glm.Tool(function_declarations=[gemini_func]))

        return gemini_tools

    def _convert_json_schema_to_gemini(self, schema: Dict[str, Any]) -> Dict[str, Any]:
        """Convert JSON Schema to Gemini parameter format."""
        # Gemini uses a simplified schema format
        return {
            "type": schema.get("type", "object"),
            "properties": schema.get("properties", {}),
            "required": schema.get("required", []),
        }

    def _convert_multimodal_content(
        self, content: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Convert OpenAI-style multimodal content to Gemini format."""
        import base64

        gemini_parts = []
        for item in content:
            if item["type"] == "text":
                gemini_parts.append({"text": item["text"]})
            elif item["type"] == "image_url":
                # Gemini supports inline images
                image_url = item["image_url"]["url"]
                if image_url.startswith("data:"):
                    # Extract and validate base64 data
                    if ";base64," not in image_url:
                        # Skip malformed data URLs without base64 marker
                        continue

                    try:
                        media_type, base64_data = image_url.split(";base64,", 1)
                        image_bytes = base64.b64decode(base64_data)
                        gemini_parts.append(
                            {
                                "inline_data": {
                                    "mime_type": media_type.replace("data:", ""),
                                    "data": image_bytes,
                                }
                            }
                        )
                    except (ValueError, base64.binascii.Error):
                        # Skip malformed data URLs or invalid base64
                        pass

        return gemini_parts
