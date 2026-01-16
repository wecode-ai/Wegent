"""
/v1/response API endpoint implementation.

This is the main API endpoint for chat_shell.
Uses ChatService for actual chat processing to avoid code duplication.
"""

import asyncio
import json
import time
import uuid
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from chat_shell.api.v1.schemas import (
    CancelRequest,
    CancelResponse,
    ContentDelta,
    ErrorEvent,
    HealthResponse,
    ReasoningDelta,
    ResponseCancelled,
    ResponseDone,
    ResponseEventType,
    ResponseRequest,
    StorageHealth,
    ToolDone,
    ToolStart,
    UsageInfo,
)

router = APIRouter(prefix="/v1", tags=["response"])

# Track active streams for cancellation and health check
_active_streams: dict[str, asyncio.Event] = {}
_start_time = time.time()


def _format_sse_event(event_type: str, data: dict) -> str:
    """Format data as SSE event."""
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _extract_stream_attributes(
    request: "ResponseRequest",
    cancel_event: asyncio.Event,
    request_id: str,
) -> dict:
    """Extract attributes from stream request for tracing."""
    attrs = {"request.id": request_id}
    if request.metadata:
        if request.metadata.task_id:
            attrs["task.id"] = request.metadata.task_id
        if request.metadata.subtask_id:
            attrs["subtask.id"] = request.metadata.subtask_id
        if request.metadata.user_id:
            attrs["user.id"] = str(request.metadata.user_id)
    if request.model_config_data:
        attrs["model.id"] = request.model_config_data.model_id or ""
        attrs["model.provider"] = request.model_config_data.model or ""
    return attrs


from shared.telemetry.decorators import trace_async_generator


@trace_async_generator(
    span_name="chat_shell.stream_response",
    tracer_name="chat_shell",
    extract_attributes=_extract_stream_attributes,
)
async def _stream_response(
    request: ResponseRequest,
    cancel_event: asyncio.Event,
    request_id: str,
) -> AsyncGenerator[str, None]:
    """
    Stream response generator using ChatService.

    Converts ResponseRequest to ChatRequest and uses ChatService for processing.
    """
    import logging

    from chat_shell.core.config import settings
    from chat_shell.core.shutdown import shutdown_manager
    from chat_shell.interface import ChatEventType, ChatRequest
    from chat_shell.services.chat_service import chat_service

    logger = logging.getLogger(__name__)

    # Register stream with shutdown manager
    await shutdown_manager.register_stream(request_id)

    response_id = f"resp-{uuid.uuid4().hex[:12]}"
    full_content = ""
    total_input_tokens = 0
    total_output_tokens = 0
    emitted_tool_run_ids: set[str] = (
        set()
    )  # Track emitted tool events to avoid duplicates
    accumulated_sources: list[dict] = []  # Track knowledge base sources for citation

    try:
        # Send response.start event
        yield _format_sse_event(
            ResponseEventType.RESPONSE_START.value,
            {
                "id": response_id,
                "model": request.model_config_data.model_id,
                "created": int(time.time()),
            },
        )

        # Build model config dict
        model_config = {
            "model_id": request.model_config_data.model_id,
            "model": request.model_config_data.model,
            "api_key": request.model_config_data.api_key,
            "base_url": request.model_config_data.base_url,
            "api_format": request.model_config_data.api_format,
            "default_headers": request.model_config_data.default_headers,
            "context_window": request.model_config_data.context_window,
            "max_output_tokens": request.model_config_data.max_output_tokens,
            "timeout": request.model_config_data.timeout,
            "max_retries": request.model_config_data.max_retries,
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
        }

        # Determine the message content
        message: str | dict = ""
        if request.input.messages:
            # Full conversation history - extract last user message
            for msg in reversed(request.input.messages):
                if msg.role == "user":
                    message = (
                        msg.content
                        if isinstance(msg.content, str)
                        else {"type": "multi_vision", "content": msg.content}
                    )
                    break
        elif request.input.content:
            # Multimodal content - convert to vision format
            message = {
                "type": "multi_vision",
                "text": "",
                "images": [],
            }
            for c in request.input.content:
                if c.type == "text" and c.text:
                    message["text"] = c.text
                elif c.type == "image" and c.source:
                    message["images"].append(
                        {
                            "image_base64": c.source.get("data", ""),
                            "mime_type": c.source.get("media_type", "image/png"),
                        }
                    )
        elif request.input.text:
            # Simple text or vision message dict
            message = request.input.text

        # Determine enable_web_search from tools.builtin or features
        # Requires both: server-side WEB_SEARCH_ENABLED=True AND explicit request
        enable_web_search = False
        if getattr(settings, "WEB_SEARCH_ENABLED", False):
            if request.tools and request.tools.builtin:
                web_search_config = request.tools.builtin.get("web_search")
                if web_search_config and web_search_config.enabled:
                    enable_web_search = True
            if request.features and request.features.web_search:
                enable_web_search = True

        # Extract MCP server configs
        mcp_servers = []
        if request.tools and request.tools.mcp_servers:
            for server in request.tools.mcp_servers:
                mcp_servers.append(
                    {
                        "name": server.name,
                        "url": server.url,
                        "type": server.type,
                        "auth": server.auth,
                    }
                )

        # Extract skill configs
        skill_configs = []
        if request.tools and request.tools.skills:
            for skill in request.tools.skills:
                skill_configs.append(
                    {
                        "name": skill.name,
                        "version": skill.version,
                        "preload": skill.preload,
                    }
                )

        # Extract metadata
        task_id = 0
        subtask_id = 0
        user_subtask_id = None  # User subtask ID for RAG persistence
        user_id = 0
        user_name = ""
        team_id = 0
        team_name = ""
        is_group_chat = False
        message_id = None
        user_message_id = None  # For history exclusion
        bot_name = ""
        bot_namespace = ""
        skill_names = []
        skill_configs_from_meta = []
        preload_skills = []
        knowledge_base_ids = None
        document_ids = None
        is_user_selected_kb = True  # Default to strict mode for backward compatibility
        table_contexts = []
        task_data = None

        if request.metadata:
            task_id = getattr(request.metadata, "task_id", 0) or 0
            subtask_id = getattr(request.metadata, "subtask_id", 0) or 0
            user_subtask_id = getattr(request.metadata, "user_subtask_id", None)
            user_id = request.metadata.user_id or 0
            user_name = request.metadata.user_name or ""
            team_id = getattr(request.metadata, "team_id", 0) or 0
            team_name = getattr(request.metadata, "team_name", "") or ""
            is_group_chat = request.metadata.chat_type == "group"
            message_id = getattr(request.metadata, "message_id", None)
            user_message_id = getattr(request.metadata, "user_message_id", None)
            bot_name = getattr(request.metadata, "bot_name", "") or ""
            bot_namespace = getattr(request.metadata, "bot_namespace", "") or ""
            skill_names = getattr(request.metadata, "skill_names", None) or []
            skill_configs_from_meta = (
                getattr(request.metadata, "skill_configs", None) or []
            )
            preload_skills = getattr(request.metadata, "preload_skills", None) or []
            knowledge_base_ids = getattr(request.metadata, "knowledge_base_ids", None)
            document_ids = getattr(request.metadata, "document_ids", None)
            # is_user_selected_kb: defaults to True if not provided (strict mode)
            is_user_selected_kb = getattr(request.metadata, "is_user_selected_kb", True)
            if is_user_selected_kb is None:
                is_user_selected_kb = True  # Ensure it's never None
            table_contexts = getattr(request.metadata, "table_contexts", None) or []
            task_data = getattr(request.metadata, "task_data", None)

        # Merge skill configs from tools and metadata
        all_skill_configs = skill_configs + skill_configs_from_meta

        # Build ChatRequest for ChatService
        chat_request = ChatRequest(
            task_id=task_id,
            subtask_id=subtask_id,
            user_subtask_id=user_subtask_id,  # User subtask ID for RAG persistence
            message=message,
            user_id=user_id,
            user_name=user_name,
            team_id=team_id,
            team_name=team_name,
            message_id=message_id,
            user_message_id=user_message_id,
            is_group_chat=is_group_chat,
            model_config=model_config,
            system_prompt=request.system or "",
            enable_tools=True,
            enable_web_search=enable_web_search,
            enable_clarification=(
                request.features.clarification if request.features else False
            ),
            enable_deep_thinking=(
                request.features.deep_thinking if request.features else False
            ),
            search_engine=(
                request.features.search_engine if request.features else None
            ),
            bot_name=bot_name,
            bot_namespace=bot_namespace,
            skills=all_skill_configs,
            skill_names=skill_names,
            skill_configs=all_skill_configs,
            preload_skills=preload_skills,
            knowledge_base_ids=knowledge_base_ids,
            document_ids=document_ids,
            is_user_selected_kb=is_user_selected_kb,
            table_contexts=table_contexts,
            task_data=task_data,
            mcp_servers=mcp_servers,
        )

        logger.info(
            "[RESPONSE] Processing request: task_id=%d, subtask_id=%d, user_subtask_id=%s, "
            "enable_web_search=%s, mcp_servers=%d, skills=%d, "
            "skill_names=%s, preload_skills=%s, knowledge_base_ids=%s, document_ids=%s, "
            "table_contexts_count=%d, table_contexts=%s",
            task_id,
            subtask_id,
            user_subtask_id,
            enable_web_search,
            len(mcp_servers),
            len(all_skill_configs),
            skill_names,
            preload_skills,
            knowledge_base_ids,
            document_ids,
            len(table_contexts),
            table_contexts,  # Log the actual content
        )

        # Record request details to trace
        from shared.telemetry.context import SpanAttributes, set_span_attributes

        set_span_attributes(
            {
                SpanAttributes.TASK_ID: task_id,
                SpanAttributes.SUBTASK_ID: subtask_id,
                SpanAttributes.MCP_SERVERS_COUNT: len(mcp_servers),
                SpanAttributes.MCP_SERVER_NAMES: (
                    ",".join(s["name"] for s in mcp_servers) if mcp_servers else ""
                ),
                SpanAttributes.SKILL_NAMES: (
                    ",".join(skill_names) if skill_names else ""
                ),
                SpanAttributes.SKILL_COUNT: len(all_skill_configs),
                SpanAttributes.KB_IDS: (
                    ",".join(map(str, knowledge_base_ids)) if knowledge_base_ids else ""
                ),
                SpanAttributes.KB_DOCUMENT_IDS: (
                    ",".join(map(str, document_ids)) if document_ids else ""
                ),
                SpanAttributes.KB_TABLE_CONTEXTS_COUNT: len(table_contexts),
                SpanAttributes.CHAT_WEB_SEARCH: enable_web_search,
                SpanAttributes.CHAT_DEEP_THINKING: (
                    request.features.deep_thinking if request.features else False
                ),
                SpanAttributes.CHAT_TYPE: "group" if is_group_chat else "single",
            }
        )

        # Stream from ChatService
        async for event in chat_service.chat(chat_request):
            # Check for cancellation
            if cancel_event.is_set():
                yield _format_sse_event(
                    ResponseEventType.RESPONSE_CANCELLED.value,
                    ResponseCancelled(
                        id=response_id,
                        partial_content=full_content,
                    ).model_dump(),
                )
                return

            # Convert ChatEvent to SSE event
            if event.type == ChatEventType.CHUNK:
                chunk_text = event.data.get("content", "")
                if chunk_text:
                    full_content += chunk_text
                    yield _format_sse_event(
                        ResponseEventType.CONTENT_DELTA.value,
                        ContentDelta(type="text", text=chunk_text).model_dump(),
                    )

                # Check for thinking data and sources in result
                result = event.data.get("result")
                logger.debug(
                    "[RESPONSE] CHUNK event: content_len=%d, has_result=%s, "
                    "thinking_count=%d",
                    len(chunk_text),
                    result is not None,
                    len(result.get("thinking", [])) if result else 0,
                )
                # Accumulate sources from result (knowledge base citations)
                if result and result.get("sources"):
                    for source in result["sources"]:
                        # Avoid duplicates based on (kb_id, title)
                        key = (source.get("kb_id"), source.get("title"))
                        existing_keys = {
                            (s.get("kb_id"), s.get("title"))
                            for s in accumulated_sources
                        }
                        if key not in existing_keys:
                            accumulated_sources.append(source)
                if result and result.get("thinking"):
                    for step in result["thinking"]:
                        details = step.get("details", {})
                        status = details.get("status")
                        tool_name = details.get("tool_name", details.get("name", ""))
                        run_id = step.get("run_id", "")
                        title = step.get("title", "")

                        # Create unique key for this tool event
                        event_key = f"{run_id}:{status}"
                        if event_key in emitted_tool_run_ids:
                            continue  # Skip already emitted events
                        emitted_tool_run_ids.add(event_key)

                        logger.info(
                            "[RESPONSE] Processing thinking step: run_id=%s, status=%s, tool=%s, title=%s",
                            run_id[:20] if run_id else "N/A",
                            status,
                            tool_name,
                            title[:30] if title else "N/A",
                        )

                        if status == "started":
                            yield _format_sse_event(
                                ResponseEventType.TOOL_START.value,
                                ToolStart(
                                    id=run_id,
                                    name=tool_name,
                                    input=details.get("input", {}),
                                    display_name=step.get("title", tool_name),
                                ).model_dump(),
                            )
                        elif status in ("completed", "failed"):
                            logger.info(
                                "[RESPONSE] Emitting TOOL_DONE: run_id=%s, status=%s, error=%s",
                                run_id[:20] if run_id else "N/A",
                                status,
                                (
                                    details.get("error", "none")[:50]
                                    if details.get("error")
                                    else "none"
                                ),
                            )
                            yield _format_sse_event(
                                ResponseEventType.TOOL_DONE.value,
                                ToolDone(
                                    id=run_id,
                                    output=details.get(
                                        "output", details.get("content")
                                    ),
                                    duration_ms=None,
                                    error=(
                                        details.get("error")
                                        if status == "failed"
                                        else None
                                    ),
                                    sources=None,
                                    display_name=title if status == "failed" else None,
                                ).model_dump(),
                            )

            elif event.type == ChatEventType.THINKING:
                thinking_text = event.data.get("content", "")
                if thinking_text:
                    yield _format_sse_event(
                        ResponseEventType.REASONING_DELTA.value,
                        ReasoningDelta(text=thinking_text).model_dump(),
                    )

            elif event.type == ChatEventType.TOOL_START:
                yield _format_sse_event(
                    ResponseEventType.TOOL_START.value,
                    ToolStart(
                        id=event.data.get("tool_call_id", ""),
                        name=event.data.get("tool_name", ""),
                        input=event.data.get("tool_input", {}),
                        display_name=event.data.get("tool_name"),
                    ).model_dump(),
                )

            elif event.type == ChatEventType.TOOL_RESULT:
                yield _format_sse_event(
                    ResponseEventType.TOOL_DONE.value,
                    ToolDone(
                        id=event.data.get("tool_call_id", ""),
                        output=event.data.get("tool_output"),
                        duration_ms=None,
                        error=None,
                        sources=None,
                    ).model_dump(),
                )

            elif event.type == ChatEventType.DONE:
                # Extract usage info if available
                result = event.data.get("result", {})
                usage = result.get("usage") if result else None
                if usage:
                    total_input_tokens = usage.get("input_tokens", 0)
                    total_output_tokens = usage.get("output_tokens", 0)

            elif event.type == ChatEventType.ERROR:
                error_msg = event.data.get("error", "Unknown error")
                yield _format_sse_event(
                    ResponseEventType.ERROR.value,
                    ErrorEvent(
                        code="internal_error",
                        message=error_msg,
                        details=None,
                    ).model_dump(),
                )
                return

            elif event.type == ChatEventType.CANCELLED:
                yield _format_sse_event(
                    ResponseEventType.RESPONSE_CANCELLED.value,
                    ResponseCancelled(
                        id=response_id,
                        partial_content=full_content,
                    ).model_dump(),
                )
                return

        # Send response.done event with accumulated sources
        # Convert accumulated_sources to SourceItem format for proper serialization
        formatted_sources = None
        if accumulated_sources:
            from chat_shell.api.v1.schemas import SourceItem

            formatted_sources = [
                SourceItem(
                    index=source.get("index"),
                    title=source.get("title", "Unknown"),
                    kb_id=source.get("kb_id"),
                    url=source.get("url"),
                    snippet=source.get("snippet"),
                )
                for source in accumulated_sources
            ]

        yield _format_sse_event(
            ResponseEventType.RESPONSE_DONE.value,
            ResponseDone(
                id=response_id,
                usage=(
                    UsageInfo(
                        input_tokens=total_input_tokens,
                        output_tokens=total_output_tokens,
                        total_tokens=total_input_tokens + total_output_tokens,
                    )
                    if total_input_tokens or total_output_tokens
                    else None
                ),
                stop_reason="end_turn",
                sources=formatted_sources,
            ).model_dump(),
        )

    except asyncio.CancelledError:
        yield _format_sse_event(
            ResponseEventType.RESPONSE_CANCELLED.value,
            ResponseCancelled(
                id=response_id,
                partial_content=full_content,
            ).model_dump(),
        )

    except Exception as e:
        import traceback

        logger.error("[RESPONSE] Error: %s\n%s", e, traceback.format_exc())
        yield _format_sse_event(
            ResponseEventType.ERROR.value,
            ErrorEvent(
                code="internal_error",
                message=str(e),
                details={"type": type(e).__name__},
            ).model_dump(),
        )

    finally:
        # Unregister stream from shutdown manager
        await shutdown_manager.unregister_stream(request_id)
        # Clean up from active streams dict
        cleanup_stream(request_id)


@router.post("/response")
async def create_response(request: ResponseRequest, req: Request):
    """
    Create a streaming response.

    This is the main endpoint for generating AI responses.
    Returns an SSE stream of events.
    """
    from shared.telemetry.context import set_request_context

    # Extract request ID from header or generate new one
    request_id = req.headers.get("X-Request-ID")
    if not request_id:
        request_id = (
            request.metadata.request_id
            if request.metadata and request.metadata.request_id
            else f"req-{uuid.uuid4().hex[:12]}"
        )

    # Set request context for log correlation
    set_request_context(request_id)

    # Create cancel event for this request
    cancel_event = asyncio.Event()
    _active_streams[request_id] = cancel_event

    try:
        return StreamingResponse(
            _stream_response(request, cancel_event, request_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Request-ID": request_id,
            },
        )
    finally:
        # Cleanup will happen when stream ends
        pass


@router.post("/response/cancel")
async def cancel_response(request: CancelRequest):
    """
    Cancel an ongoing response.

    This endpoint allows cancelling a streaming response by its request ID.
    """
    request_id = request.request_id

    if request_id not in _active_streams:
        raise HTTPException(
            status_code=404, detail="Request not found or already completed"
        )

    cancel_event = _active_streams.get(request_id)
    if cancel_event:
        cancel_event.set()
        return CancelResponse(success=True, message="Request cancelled")

    return CancelResponse(success=False, message="Request not found")


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.

    Returns service health status including storage and model provider status.
    """
    from chat_shell import __version__ as version

    uptime = int(time.time() - _start_time)

    return HealthResponse(
        status="healthy",
        version=version,
        uptime_seconds=uptime,
        active_streams=len(_active_streams),
        storage=StorageHealth(type="memory", status="ok"),
        model_providers=None,  # Could be populated with actual checks
    )


def cleanup_stream(request_id: str):
    """Clean up stream resources after completion."""
    if request_id in _active_streams:
        del _active_streams[request_id]
