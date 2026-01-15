# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP/SSE adapter for Chat Shell remote communication.

This adapter is used when Chat Shell runs as an independent service
and communicates with Backend via HTTP/SSE.
"""

import json
import logging
from typing import AsyncIterator, Optional

import httpx
from shared.telemetry.context.propagation import inject_trace_context_to_headers

from .interface import ChatEvent, ChatEventType, ChatInterface, ChatRequest

logger = logging.getLogger(__name__)


class HTTPAdapter(ChatInterface):
    """HTTP/SSE adapter for remote Chat Shell communication.

    This adapter communicates with Chat Shell service via HTTP requests
    and SSE streaming responses.
    """

    # Mapping from SSE event names to ChatEventType
    SSE_EVENT_TYPE_MAP = {
        "response.start": ChatEventType.START,
        "content.delta": ChatEventType.CHUNK,
        "thinking.delta": ChatEventType.THINKING,
        "tool.start": ChatEventType.TOOL_START,
        "tool.done": ChatEventType.TOOL_RESULT,
        "response.done": ChatEventType.DONE,
        "response.cancelled": ChatEventType.CANCELLED,
        "response.error": ChatEventType.ERROR,
    }

    def __init__(
        self,
        base_url: str,
        token: str = "",
        timeout: float = 300.0,
    ):
        """Initialize HTTP adapter.

        Args:
            base_url: Chat Shell service base URL
            token: Internal service authentication token
            timeout: HTTP request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._current_event_type: Optional[str] = None

    def _get_headers(self) -> dict:
        """Get HTTP headers for requests."""
        from shared.telemetry.context import get_request_id

        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        # Inject trace context for distributed tracing
        inject_trace_context_to_headers(headers)
        # Inject request ID for log correlation
        request_id = get_request_id()
        if request_id:
            headers["X-Request-ID"] = request_id
        return headers

    def _build_response_request(self, request: ChatRequest) -> dict:
        """Build /v1/response request payload from ChatRequest.

        Converts Backend's ChatRequest to chat_shell's ResponseRequest format.

        Backend's model_config structure:
        - model_id: Model name (e.g. "gpt-4")
        - model: Provider (e.g. "openai")
        - api_key: API key
        - base_url: API base URL
        """
        # Build model config - filter out None values to avoid validation errors
        # Note: Backend uses "model_id" for model name, "model" for provider
        model_config = {
            "model_id": request.model_config.get("model_id") or "gpt-4",
            "model": request.model_config.get("model") or "openai",
            "api_key": request.model_config.get("api_key") or "",
            "api_format": request.model_config.get("api_format") or "chat",
            "default_headers": request.model_config.get("default_headers") or {},
            "timeout": request.model_config.get("timeout") or 120.0,
            "max_retries": request.model_config.get("max_retries") or 3,
        }

        # Only add optional fields if they have values
        if request.model_config.get("base_url"):
            model_config["base_url"] = request.model_config["base_url"]
        if request.model_config.get("context_window"):
            model_config["context_window"] = request.model_config["context_window"]
        if request.model_config.get("max_output_tokens"):
            model_config["max_output_tokens"] = request.model_config[
                "max_output_tokens"
            ]

        # Build input config - handle multimodal messages
        if isinstance(request.message, dict) and request.message.get("type") in (
            "vision",
            "multi_vision",
        ):
            # Multimodal message with images - pass directly as text
            # chat_shell's InputConfig.text is Union[str, dict] to support vision messages
            input_config = {"text": request.message}
        else:
            # Simple text message
            input_config = {"text": request.message}

        # Build features config
        features = {
            "web_search": request.enable_web_search,
            "clarification": request.enable_clarification,
            "deep_thinking": request.enable_deep_thinking,
        }
        if request.search_engine:
            features["search_engine"] = request.search_engine

        # Build metadata
        metadata = {
            "task_id": request.task_id,
            "subtask_id": request.subtask_id,
            "user_subtask_id": request.user_subtask_id,  # User subtask ID for RAG persistence
            "user_id": request.user_id,
            "user_name": request.user_name,
            "team_id": request.team_id,
            "team_name": request.team_name,
            "chat_type": "group" if request.is_group_chat else "single",
            "message_id": request.message_id,
            "user_message_id": request.user_message_id,  # For history exclusion
            "bot_name": request.bot_name,
            "bot_namespace": request.bot_namespace,
            # Additional fields for HTTP mode
            "skill_names": request.skill_names,
            "skill_configs": request.skill_configs,
            "preload_skills": request.preload_skills,
            "knowledge_base_ids": request.knowledge_base_ids,
            "document_ids": request.document_ids,
            "is_user_selected_kb": request.is_user_selected_kb,
            "table_contexts": request.table_contexts,
            "task_data": request.task_data,
        }

        payload = {
            "model_config": model_config,
            "input": input_config,
            "session_id": f"task-{request.task_id}",
            "include_history": True,
            "system": request.system_prompt,
            "features": features,
            "metadata": metadata,
        }

        # Build tools configuration
        tools_config = {}

        # Add builtin tools (web_search)
        if request.enable_web_search:
            builtin = tools_config.setdefault("builtin", {})
            builtin["web_search"] = {"enabled": True}
            if request.search_engine:
                builtin["web_search"]["engine"] = request.search_engine

        # Add MCP servers
        # mcp_servers is now a list: [{"name": "...", "url": "...", "type": "...", "auth": ...}]
        if request.mcp_servers:
            tools_config["mcp_servers"] = request.mcp_servers

        # Add skills if provided
        if request.skills:
            tools_config["skills"] = [
                {"name": s.get("name", ""), "description": s.get("description", "")}
                for s in request.skills
                if isinstance(s, dict)
            ]

        if tools_config:
            payload["tools"] = tools_config

        return payload

    async def chat(self, request: ChatRequest) -> AsyncIterator[ChatEvent]:
        """Send chat request and stream SSE events.

        Args:
            request: Chat request data

        Yields:
            ChatEvent: Events from Chat Shell
        """
        # Reset event type state for new request
        self._current_event_type = None

        url = f"{self.base_url}/v1/response"
        headers = self._get_headers()

        logger.info(
            "[HTTP_ADAPTER] Chat request: task_id=%d, subtask_id=%d, url=%s",
            request.task_id,
            request.subtask_id,
            url,
        )

        # Build request payload in ResponseRequest format
        payload = self._build_response_request(request)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                async with client.stream(
                    "POST",
                    url,
                    json=payload,
                    headers=headers,
                ) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        logger.error(
                            "[HTTP_ADAPTER] Chat request failed: status=%d, error=%s",
                            response.status_code,
                            error_text.decode(),
                        )
                        yield ChatEvent(
                            type=ChatEventType.ERROR,
                            data={
                                "error": f"HTTP {response.status_code}: {error_text.decode()}",
                                "subtask_id": request.subtask_id,
                            },
                        )
                        return

                    logger.debug("[HTTP_ADAPTER] Starting to read SSE stream...")
                    async for line in response.aiter_lines():
                        event = self._parse_sse_line(line)
                        if event:
                            yield event
                            if event.type in (
                                ChatEventType.DONE,
                                ChatEventType.ERROR,
                                ChatEventType.CANCELLED,
                            ):
                                logger.debug(
                                    "[HTTP_ADAPTER] Terminal event received, ending stream"
                                )
                                # Properly close the response before returning
                                # to avoid "async generator ignored GeneratorExit" warning
                                await response.aclose()
                                return

            except httpx.TimeoutException as e:
                logger.error(
                    "[HTTP_ADAPTER] Chat request timeout: task_id=%d, error=%s",
                    request.task_id,
                    e,
                )
                yield ChatEvent(
                    type=ChatEventType.ERROR,
                    data={
                        "error": "Request timeout",
                        "subtask_id": request.subtask_id,
                    },
                )

            except httpx.RequestError as e:
                logger.error(
                    "[HTTP_ADAPTER] Chat request error: task_id=%d, error=%s",
                    request.task_id,
                    e,
                )
                yield ChatEvent(
                    type=ChatEventType.ERROR,
                    data={
                        "error": str(e),
                        "subtask_id": request.subtask_id,
                    },
                )

    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ChatEvent]:
        """Resume streaming from Chat Shell.

        Args:
            subtask_id: Subtask ID to resume
            offset: Character offset to resume from

        Yields:
            ChatEvent: Events from the resumed position
        """
        url = f"{self.base_url}/v1/chat/resume/{subtask_id}"
        headers = self._get_headers()
        params = {"offset": offset}

        logger.info(
            "[HTTP_ADAPTER] Resume request: subtask_id=%d, offset=%d",
            subtask_id,
            offset,
        )

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                async with client.stream(
                    "GET",
                    url,
                    params=params,
                    headers=headers,
                ) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        logger.error(
                            "[HTTP_ADAPTER] Resume request failed: status=%d",
                            response.status_code,
                        )
                        yield ChatEvent(
                            type=ChatEventType.ERROR,
                            data={
                                "error": f"HTTP {response.status_code}: {error_text.decode()}",
                                "subtask_id": subtask_id,
                            },
                        )
                        return

                    async for line in response.aiter_lines():
                        event = self._parse_sse_line(line)
                        if event:
                            yield event
                            if event.type in (
                                ChatEventType.DONE,
                                ChatEventType.ERROR,
                                ChatEventType.CANCELLED,
                            ):
                                # Properly close the response before returning
                                # to avoid "async generator ignored GeneratorExit" warning
                                await response.aclose()
                                return

            except Exception as e:
                logger.error(
                    "[HTTP_ADAPTER] Resume request error: subtask_id=%d, error=%s",
                    subtask_id,
                    e,
                )
                yield ChatEvent(
                    type=ChatEventType.ERROR,
                    data={
                        "error": str(e),
                        "subtask_id": subtask_id,
                    },
                )

    async def cancel(self, subtask_id: int) -> bool:
        """Cancel an ongoing chat request via HTTP.

        Note: In practice, cancellation is typically done via Redis Pub/Sub
        for lower latency. This HTTP endpoint is a fallback.

        Args:
            subtask_id: Subtask ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        url = f"{self.base_url}/v1/chat/cancel/{subtask_id}"
        headers = self._get_headers()
        headers["Accept"] = "application/json"

        logger.info(
            "[HTTP_ADAPTER] Cancel request: subtask_id=%d",
            subtask_id,
        )

        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                response = await client.post(url, headers=headers)
                if response.status_code == 200:
                    data = response.json()
                    return data.get("success", False)
                else:
                    logger.error(
                        "[HTTP_ADAPTER] Cancel request failed: status=%d",
                        response.status_code,
                    )
                    return False

            except Exception as e:
                logger.error(
                    "[HTTP_ADAPTER] Cancel request error: subtask_id=%d, error=%s",
                    subtask_id,
                    e,
                )
                return False

    def _parse_sse_line(self, line: str) -> Optional[ChatEvent]:
        """Parse SSE line to ChatEvent.

        SSE format from chat_shell:
        - event: response.start / content.delta / response.done
        - data: {"type": "text", "text": "...", "data": {...}}

        We track the event: line and use it to determine ChatEventType.

        Args:
            line: SSE line (e.g., "event: content.delta" or "data: {...}")

        Returns:
            ChatEvent or None if line is not valid data
        """
        if not line:
            return None

        # Track event type from "event:" line
        if line.startswith("event:"):
            event_name = line[6:].strip()
            self._current_event_type = event_name
            logger.debug("[HTTP_ADAPTER] SSE event type: %s", event_name)
            return None

        if line.startswith("data:"):
            data_str = line[5:].strip()

            # Check for [DONE] marker
            if data_str == "[DONE]":
                return None

            try:
                data = json.loads(data_str)

                # Map SSE event name to ChatEventType
                event_type = self.SSE_EVENT_TYPE_MAP.get(
                    self._current_event_type or "", ChatEventType.CHUNK
                )

                # Build event data based on event type
                event_data = {}

                if event_type == ChatEventType.CHUNK:
                    # Text content is in "text" field
                    text = data.get("text", "")
                    if text:
                        event_data["content"] = text
                elif event_type == ChatEventType.THINKING:
                    # Thinking content is in "text" field
                    text = data.get("text", "")
                    if text:
                        event_data["content"] = text
                elif event_type == ChatEventType.DONE:
                    # Done event - chat_shell's ResponseDone has {id, usage, stop_reason, sources}
                    # The actual response content is NOT in this event, it's accumulated from CHUNK events
                    # We pass through the metadata (usage, stop_reason, sources) and let the caller set 'value'
                    event_data["result"] = {
                        "usage": data.get("usage"),
                        "stop_reason": data.get("stop_reason"),
                        "id": data.get("id"),
                        "sources": data.get("sources"),  # Knowledge base citations
                    }
                elif event_type in (
                    ChatEventType.TOOL_START,
                    ChatEventType.TOOL_RESULT,
                ):
                    # Tool events - fields are at top level (id, name, input, display_name, output)
                    # Map to expected field names for backend processing
                    event_data["id"] = data.get("id", "")
                    event_data["name"] = data.get("name", "")
                    event_data["display_name"] = data.get(
                        "display_name", data.get("name", "")
                    )
                    if event_type == ChatEventType.TOOL_START:
                        event_data["input"] = data.get("input", {})
                    else:  # TOOL_RESULT
                        event_data["output"] = data.get("output", "")
                        # Include error field for failed tools
                        if data.get("error"):
                            event_data["error"] = data.get("error")
                    logger.info(
                        "[HTTP_ADAPTER] Parsed %s event: data=%s, event_data=%s",
                        event_type.value,
                        {k: v for k, v in data.items() if k != "output"},
                        {k: v for k, v in event_data.items() if k != "output"},
                    )
                elif event_type == ChatEventType.ERROR:
                    # Error event from chat_shell has {code, message, details} format
                    event_data["error"] = data.get("message") or data.get(
                        "error", "Unknown error"
                    )
                    event_data["code"] = data.get("code", "internal_error")
                elif event_type == ChatEventType.START:
                    # Start event, no special data needed
                    pass

                return ChatEvent(type=event_type, data=event_data)

            except json.JSONDecodeError:
                logger.warning(
                    "[HTTP_ADAPTER] Failed to parse SSE data: %s",
                    data_str[:100],
                )
                return None

        return None
