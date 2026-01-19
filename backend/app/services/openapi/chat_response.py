# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat response handlers for OpenAPI v1/responses endpoint.
Contains streaming and synchronous response implementations.

Supports all OpenAI response output types:
- message: Text output from the model
- mcp_call: MCP server tool calls (all server-side tool execution uses this type)
- reasoning: Chain of thought reasoning
- web_search_call: Web search results

Note: function_call type is NOT used for server-side tools because OpenAI API treats
function_call as "client should execute this function". All server-executed tools
are reported as mcp_call to prevent client SDKs from trying to execute them.
"""

import json
import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Task
from app.schemas.openapi_response import (
    McpCall,
    OutputMessage,
    OutputTextContent,
    ReasoningItem,
    ResponseCreateInput,
    ResponseObject,
    ResponseOutputItem,
    WebSearchToolCall,
)
from app.services.openapi.chat_session import (
    build_chat_history,
    setup_chat_session,
)
from app.services.openapi.streaming import StreamEvent, StreamEventType

logger = logging.getLogger(__name__)


async def create_streaming_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> StreamingResponse:
    """
    Create a streaming response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.
    Uses HTTP adapter to call remote chat_shell service.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_key_name: Optional API key name

    Returns:
        StreamingResponse with SSE events
    """
    return await _create_streaming_response_http(
        db=db,
        user=user,
        team=team,
        model_info=model_info,
        request_body=request_body,
        input_text=input_text,
        tool_settings=tool_settings,
        task_id=task_id,
        api_key_name=api_key_name,
    )


async def _create_streaming_response_http(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> StreamingResponse:
    """Create streaming response using HTTP adapter to call remote chat_shell service."""
    from app.core.config import settings
    from app.services.chat.adapters.http import HTTPAdapter
    from app.services.chat.adapters.interface import ChatEventType, ChatRequest
    from app.services.chat.storage import db_handler, session_manager
    from app.services.openapi.streaming import streaming_service

    # Set up chat session (config, task, subtasks)
    setup = setup_chat_session(
        db,
        user,
        team,
        model_info,
        input_text,
        tool_settings,
        task_id,
        api_key_name,
    )

    response_id = f"resp_{setup.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = setup.assistant_subtask.id
    user_subtask_id = (
        setup.user_subtask.id
    )  # User subtask ID for RAG result persistence
    user_message_id = (
        setup.user_subtask.message_id
    )  # User message_id for history exclusion
    task_kind_id = setup.task_id
    enable_chat_bot = tool_settings.get("enable_chat_bot", False)

    # Prepare MCP servers for HTTP mode
    # Only load MCP servers when tools are explicitly enabled via enable_chat_bot
    # This ensures /api/v1/responses without tools parameter doesn't auto-load tools
    mcp_servers_to_pass = []

    # 1. Load bot MCP servers from Ghost CRD
    if setup.bot_name:
        try:
            from app.services.openapi.mcp import _get_bot_mcp_servers_sync

            bot_mcp_servers = _get_bot_mcp_servers_sync(
                team.user_id, setup.bot_name, setup.bot_namespace
            )
            if bot_mcp_servers:
                # Convert to chat_shell expected format
                for name, config in bot_mcp_servers.items():
                    if isinstance(config, dict):
                        server_entry = {
                            "name": name,
                            "url": config.get("url", ""),
                            "type": config.get("type", "streamable-http"),
                        }
                        if config.get("headers"):
                            server_entry["auth"] = config["headers"]
                        mcp_servers_to_pass.append(server_entry)
                logger.info(
                    f"[OPENAPI_HTTP] Loaded {len(bot_mcp_servers)} bot MCP servers for HTTP mode: "
                    f"bot={setup.bot_namespace}/{setup.bot_name}"
                )
        except Exception as e:
            logger.warning(f"[OPENAPI_HTTP] Failed to load bot MCP servers: {e}")

    # 2. Add custom MCP servers from API request
    custom_mcp_servers = tool_settings.get("mcp_servers", {})
    if custom_mcp_servers:
        for name, config in custom_mcp_servers.items():
            if isinstance(config, dict) and config.get("url"):
                server_entry = {
                    "name": name,
                    "url": config.get("url", ""),
                    "type": config.get("type", "streamable-http"),
                }
                if config.get("headers"):
                    server_entry["auth"] = config["headers"]
                mcp_servers_to_pass.append(server_entry)
        logger.info(
            f"[OPENAPI_HTTP] Added {len(custom_mcp_servers)} custom MCP servers from request"
        )

    async def raw_chat_stream() -> AsyncGenerator[StreamEvent, None]:
        """Generate structured stream events from HTTP adapter.

        Yields StreamEvent objects for text, tool calls, reasoning, etc.
        """
        from app.api.dependencies import get_db as get_db_session

        accumulated_content = ""
        accumulated_reasoning = ""
        thinking_steps: List[Dict[str, Any]] = []  # For backward compatibility
        tool_calls: Dict[str, Dict[str, Any]] = {}  # Track tool calls by ID
        db_gen = next(get_db_session())

        try:
            cancel_event = await session_manager.register_stream(assistant_subtask_id)
            await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

            # Build system prompt with optional deep thinking enhancement
            from chat_shell.prompts import append_deep_thinking_prompt

            final_system_prompt = append_deep_thinking_prompt(
                setup.system_prompt, enable_chat_bot
            )

            # Build chat history
            history = build_chat_history(setup.existing_subtasks)

            # Create HTTP adapter
            adapter = HTTPAdapter(
                base_url=settings.CHAT_SHELL_URL,
                token=settings.CHAT_SHELL_TOKEN,
            )

            # Build ChatRequest
            chat_request = ChatRequest(
                task_id=task_kind_id,
                subtask_id=assistant_subtask_id,
                user_subtask_id=user_subtask_id,  # For RAG result persistence
                user_message_id=user_message_id,  # For history exclusion (prevent duplicate messages)
                message=input_text,
                user_id=user.id,
                user_name=user.user_name or "",
                team_id=team.id,
                team_name=team.name,
                model_config=setup.model_config,
                system_prompt=final_system_prompt,
                history=history,
                enable_deep_thinking=enable_chat_bot,
                enable_web_search=enable_chat_bot and settings.WEB_SEARCH_ENABLED,
                bot_name=setup.bot_name,
                bot_namespace=setup.bot_namespace,
                mcp_servers=mcp_servers_to_pass,
                skill_names=setup.skill_names,
                skill_configs=setup.skill_configs,
                preload_skills=setup.preload_skills,
            )

            # Stream from HTTP adapter
            async for event in adapter.chat(chat_request):
                if cancel_event.is_set() or await session_manager.is_cancelled(
                    assistant_subtask_id
                ):
                    logger.info(f"Stream cancelled for subtask {assistant_subtask_id}")
                    break

                if event.type == ChatEventType.CHUNK:
                    content = event.data.get("content", "")
                    if content:
                        accumulated_content += content
                        yield StreamEvent(
                            type=StreamEventType.TEXT_CHUNK,
                            data={"content": content},
                        )

                elif event.type == ChatEventType.REASONING:
                    # Reasoning content (DeepSeek R1, etc.)
                    content = event.data.get("content", "")
                    if content:
                        accumulated_reasoning += content
                        yield StreamEvent(
                            type=StreamEventType.REASONING_CHUNK,
                            data={"content": content},
                        )

                elif event.type == ChatEventType.TOOL_START:
                    # Tool call started
                    tool_id = event.data.get("id", "")
                    tool_name = event.data.get("name", "")
                    tool_input = event.data.get("input", {})
                    display_name = event.data.get("display_name", tool_name)

                    # Track tool call for result matching
                    tool_calls[tool_id] = {
                        "id": tool_id,
                        "name": tool_name,
                        "input": tool_input,
                        "display_name": display_name,
                    }

                    # Add to thinking steps for backward compatibility
                    thinking_steps.append(
                        {
                            "title": f"Using {display_name}",
                            "next_action": "tool_use",
                            "details": {
                                "type": "tool_use",
                                "id": tool_id,
                                "name": tool_name,
                                "input": tool_input,
                            },
                        }
                    )

                    yield StreamEvent(
                        type=StreamEventType.TOOL_START,
                        data={
                            "id": tool_id,
                            "name": tool_name,
                            "input": tool_input,
                            "display_name": display_name,
                        },
                    )

                elif event.type == ChatEventType.TOOL_RESULT:
                    # Tool call completed
                    tool_id = event.data.get("id", "")
                    tool_output = event.data.get("output", "")
                    tool_error = event.data.get("error")

                    # Update tool call tracking
                    if tool_id in tool_calls:
                        tool_calls[tool_id]["output"] = tool_output
                        if tool_error:
                            tool_calls[tool_id]["error"] = tool_error

                    # Add to thinking steps for backward compatibility
                    thinking_steps.append(
                        {
                            "title": f"Tool result",
                            "next_action": "tool_result",
                            "details": {
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": str(tool_output),
                                "is_error": bool(tool_error),
                                "error_message": tool_error,
                            },
                        }
                    )

                    yield StreamEvent(
                        type=StreamEventType.TOOL_DONE,
                        data={
                            "id": tool_id,
                            "output": tool_output,
                            "error": tool_error,
                        },
                    )

                elif event.type == ChatEventType.SOURCES_UPDATE:
                    # Knowledge base citations update
                    sources = event.data.get("sources", [])
                    yield StreamEvent(
                        type=StreamEventType.SOURCES_UPDATE,
                        data={"sources": sources},
                    )

                elif event.type == ChatEventType.ERROR:
                    error_msg = event.data.get("error", "Unknown error")
                    logger.error(f"[OPENAPI_HTTP] Error from chat_shell: {error_msg}")
                    yield StreamEvent(
                        type=StreamEventType.ERROR,
                        data={"error": error_msg},
                    )
                    raise Exception(error_msg)

                elif event.type == ChatEventType.DONE:
                    logger.info(
                        f"[OPENAPI_HTTP] Stream completed for subtask {assistant_subtask_id}"
                    )
                    yield StreamEvent(type=StreamEventType.DONE, data={})

            # Stream completed (not cancelled)
            if not cancel_event.is_set() and not await session_manager.is_cancelled(
                assistant_subtask_id
            ):
                # Build result with backward compatibility
                result: Dict[str, Any] = {"value": accumulated_content}
                if thinking_steps:
                    result["thinking"] = thinking_steps
                if accumulated_reasoning:
                    result["reasoning_content"] = accumulated_reasoning

                await session_manager.save_streaming_content(
                    assistant_subtask_id, accumulated_content
                )
                await session_manager.append_user_and_assistant_messages(
                    task_kind_id, input_text, accumulated_content
                )
                await db_handler.update_subtask_status(
                    assistant_subtask_id, "COMPLETED", result=result
                )

                # Update task status
                task_kind = db_gen.query(Kind).filter(Kind.id == task_kind_id).first()
                if task_kind:
                    task_crd = Task.model_validate(task_kind.json)
                    if task_crd.status:
                        task_crd.status.status = "COMPLETED"
                        task_crd.status.updatedAt = datetime.now()
                        task_crd.status.completedAt = datetime.now()
                        task_kind.json = task_crd.model_dump(mode="json")
                        from sqlalchemy.orm.attributes import flag_modified

                        flag_modified(task_kind, "json")
                        db_gen.commit()

        except Exception as e:
            logger.exception(f"Error in HTTP streaming: {e}")
            try:
                await db_handler.update_subtask_status(
                    assistant_subtask_id, "FAILED", error=str(e)
                )
            except Exception:
                pass
            raise
        finally:
            await session_manager.unregister_stream(assistant_subtask_id)
            await session_manager.delete_streaming_content(assistant_subtask_id)
            db_gen.close()

    async def generate():
        async for event in streaming_service.create_multi_output_streaming_response(
            response_id=response_id,
            model_string=request_body.model,
            event_stream=raw_chat_stream(),
            created_at=created_at,
            previous_response_id=request_body.previous_response_id,
        ):
            yield event

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def create_sync_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> ResponseObject:
    """
    Create a synchronous (blocking) response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.
    Uses HTTP adapter to call remote chat_shell service.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_key_name: Optional API key name

    Returns:
        ResponseObject with completed status and output
    """
    return await _create_sync_response_http(
        db=db,
        user=user,
        team=team,
        model_info=model_info,
        request_body=request_body,
        input_text=input_text,
        tool_settings=tool_settings,
        task_id=task_id,
        api_key_name=api_key_name,
    )


async def _create_sync_response_http(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> ResponseObject:
    """Create sync response using HTTP adapter to call remote chat_shell service."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.core.config import settings
    from app.services.chat.adapters.http import HTTPAdapter
    from app.services.chat.adapters.interface import ChatEventType, ChatRequest
    from app.services.chat.storage import db_handler, session_manager

    # Set up chat session (config, task, subtasks)
    setup = setup_chat_session(
        db,
        user,
        team,
        model_info,
        input_text,
        tool_settings,
        task_id,
        api_key_name,
    )

    response_id = f"resp_{setup.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = setup.assistant_subtask.id
    user_subtask_id = (
        setup.user_subtask.id
    )  # User subtask ID for RAG result persistence
    user_message_id = (
        setup.user_subtask.message_id
    )  # User message_id for history exclusion
    enable_chat_bot = tool_settings.get("enable_chat_bot", False)

    # Prepare MCP servers for HTTP mode
    # Only load MCP servers when tools are explicitly enabled via enable_chat_bot
    # This ensures /api/v1/responses without tools parameter doesn't auto-load tools
    mcp_servers_to_pass = []

    # 1. Load bot MCP servers from Ghost CRD
    if setup.bot_name:
        try:
            from app.services.openapi.mcp import _get_bot_mcp_servers_sync

            bot_mcp_servers = _get_bot_mcp_servers_sync(
                team.user_id, setup.bot_name, setup.bot_namespace
            )
            if bot_mcp_servers:
                # Convert to chat_shell expected format
                for name, config in bot_mcp_servers.items():
                    if isinstance(config, dict):
                        server_entry = {
                            "name": name,
                            "url": config.get("url", ""),
                            "type": config.get("type", "streamable-http"),
                        }
                        if config.get("headers"):
                            server_entry["auth"] = config["headers"]
                        mcp_servers_to_pass.append(server_entry)
                logger.info(
                    f"[OPENAPI_HTTP_SYNC] Loaded {len(bot_mcp_servers)} bot MCP servers for HTTP mode: "
                    f"bot={setup.bot_namespace}/{setup.bot_name}"
                )
        except Exception as e:
            logger.warning(f"[OPENAPI_HTTP_SYNC] Failed to load bot MCP servers: {e}")

    # 2. Add custom MCP servers from API request
    custom_mcp_servers = tool_settings.get("mcp_servers", {})
    if custom_mcp_servers:
        for name, config in custom_mcp_servers.items():
            if isinstance(config, dict) and config.get("url"):
                server_entry = {
                    "name": name,
                    "url": config.get("url", ""),
                    "type": config.get("type", "streamable-http"),
                }
                if config.get("headers"):
                    server_entry["auth"] = config["headers"]
                mcp_servers_to_pass.append(server_entry)
        logger.info(
            f"[OPENAPI_HTTP_SYNC] Added {len(custom_mcp_servers)} custom MCP servers from request"
        )

    # Update subtask status to RUNNING
    await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

    accumulated_content = ""
    accumulated_reasoning = ""
    thinking_steps: List[Dict[str, Any]] = []  # For backward compatibility
    tool_calls: Dict[str, Dict[str, Any]] = {}  # Track tool calls by ID

    try:
        # Build system prompt with optional deep thinking enhancement
        from chat_shell.prompts import append_deep_thinking_prompt

        final_system_prompt = append_deep_thinking_prompt(
            setup.system_prompt, enable_chat_bot
        )

        # Build chat history
        history = build_chat_history(setup.existing_subtasks)

        # Create HTTP adapter
        adapter = HTTPAdapter(
            base_url=settings.CHAT_SHELL_URL,
            token=settings.CHAT_SHELL_TOKEN,
        )

        # Build ChatRequest
        chat_request = ChatRequest(
            task_id=setup.task_id,
            subtask_id=assistant_subtask_id,
            user_subtask_id=user_subtask_id,  # For RAG result persistence
            user_message_id=user_message_id,  # For history exclusion (prevent duplicate messages)
            message=input_text,
            user_id=user.id,
            user_name=user.user_name or "",
            team_id=team.id,
            team_name=team.name,
            model_config=setup.model_config,
            system_prompt=final_system_prompt,
            history=history,
            enable_deep_thinking=enable_chat_bot,
            enable_web_search=enable_chat_bot and settings.WEB_SEARCH_ENABLED,
            bot_name=setup.bot_name,
            bot_namespace=setup.bot_namespace,
            mcp_servers=mcp_servers_to_pass,
            skill_names=setup.skill_names,
            skill_configs=setup.skill_configs,
            preload_skills=setup.preload_skills,
        )

        # Stream from HTTP adapter and accumulate all output types
        async for event in adapter.chat(chat_request):
            if event.type == ChatEventType.CHUNK:
                content = event.data.get("content", "")
                if content:
                    accumulated_content += content

            elif event.type == ChatEventType.REASONING:
                # Reasoning content (DeepSeek R1, etc.)
                content = event.data.get("content", "")
                if content:
                    accumulated_reasoning += content

            elif event.type == ChatEventType.TOOL_START:
                # Tool call started
                tool_id = event.data.get("id", "")
                tool_name = event.data.get("name", "")
                tool_input = event.data.get("input", {})
                display_name = event.data.get("display_name", tool_name)

                # Track tool call for result matching
                tool_calls[tool_id] = {
                    "id": tool_id,
                    "name": tool_name,
                    "input": tool_input,
                    "display_name": display_name,
                }

                # Add to thinking steps for backward compatibility
                thinking_steps.append(
                    {
                        "title": f"Using {display_name}",
                        "next_action": "tool_use",
                        "details": {
                            "type": "tool_use",
                            "id": tool_id,
                            "name": tool_name,
                            "input": tool_input,
                        },
                    }
                )

            elif event.type == ChatEventType.TOOL_RESULT:
                # Tool call completed
                tool_id = event.data.get("id", "")
                tool_output = event.data.get("output", "")
                tool_error = event.data.get("error")

                # Update tool call tracking
                if tool_id in tool_calls:
                    tool_calls[tool_id]["output"] = tool_output
                    if tool_error:
                        tool_calls[tool_id]["error"] = tool_error

                # Add to thinking steps for backward compatibility
                thinking_steps.append(
                    {
                        "title": "Tool result",
                        "next_action": "tool_result",
                        "details": {
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": str(tool_output),
                            "is_error": bool(tool_error),
                            "error_message": tool_error,
                        },
                    }
                )

            elif event.type == ChatEventType.ERROR:
                error_msg = event.data.get("error", "Unknown error")
                logger.error(f"[OPENAPI_HTTP_SYNC] Error from chat_shell: {error_msg}")
                raise Exception(error_msg)

            elif event.type == ChatEventType.DONE:
                logger.info(
                    f"[OPENAPI_HTTP_SYNC] Stream completed for subtask {assistant_subtask_id}"
                )

        # Build result with backward compatibility
        result: Dict[str, Any] = {"value": accumulated_content}
        if thinking_steps:
            result["thinking"] = thinking_steps
        if accumulated_reasoning:
            result["reasoning_content"] = accumulated_reasoning

        # Update subtask to completed
        await db_handler.update_subtask_status(
            assistant_subtask_id, "COMPLETED", result=result
        )

        # Save chat history
        await session_manager.append_user_and_assistant_messages(
            setup.task_id, input_text, accumulated_content
        )

        # Update task status
        task_crd = Task.model_validate(setup.task.json)
        if task_crd.status:
            task_crd.status.status = "COMPLETED"
            task_crd.status.updatedAt = datetime.now()
            task_crd.status.completedAt = datetime.now()
            task_crd.status.result = result
            setup.task.json = task_crd.model_dump(mode="json")
            setup.task.updated_at = datetime.now()
            flag_modified(setup.task, "json")
            db.commit()

    except Exception as e:
        logger.exception(f"Error in HTTP sync chat response: {e}")
        error_message = str(e)
        await db_handler.update_subtask_status(
            assistant_subtask_id, "FAILED", error=error_message
        )

        # Update task status to FAILED
        task_crd = Task.model_validate(setup.task.json)
        if task_crd.status:
            task_crd.status.status = "FAILED"
            task_crd.status.errorMessage = error_message
            task_crd.status.updatedAt = datetime.now()
            setup.task.json = task_crd.model_dump(mode="json")
            setup.task.updated_at = datetime.now()
            from sqlalchemy.orm.attributes import flag_modified

            flag_modified(setup.task, "json")
            db.commit()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {error_message}",
        )

    # Build response with all output types
    message_id = f"msg_{assistant_subtask_id}"
    output: List[ResponseOutputItem] = []

    # Add message output if there's content
    if accumulated_content:
        output.append(
            OutputMessage(
                id=message_id,
                status="completed",
                role="assistant",
                content=[OutputTextContent(text=accumulated_content)],
            )
        )

    # Add reasoning output if present
    if accumulated_reasoning:
        reasoning_id = f"reasoning_{assistant_subtask_id}"
        output.append(
            ReasoningItem(
                id=reasoning_id,
                summary=[
                    {
                        "type": "summary_text",
                        "text": (
                            accumulated_reasoning[:500] + "..."
                            if len(accumulated_reasoning) > 500
                            else accumulated_reasoning
                        ),
                    }
                ],
                status="completed",
            )
        )

    # Add tool call outputs
    # IMPORTANT: All server-side tool executions are reported as mcp_call, NOT function_call
    # function_call type in OpenAI API means "client should execute this function"
    # Using mcp_call prevents client SDKs from trying to execute server-side tools
    for tool_id, tool_data in tool_calls.items():
        tool_name = tool_data.get("name", "")
        tool_input = tool_data.get("input", {})
        tool_output = tool_data.get("output", "")
        tool_error = tool_data.get("error")
        display_name = tool_data.get("display_name", tool_name)

        # Determine tool type based on name pattern
        is_web_search = (
            "web_search" in tool_name.lower() or "search" in tool_name.lower()
        )

        if is_web_search:
            output.append(
                WebSearchToolCall(
                    id=tool_id,
                    status="failed" if tool_error else "completed",
                )
            )
        else:
            # Use mcp_call for all server-executed tools (not function_call)
            output.append(
                McpCall(
                    id=tool_id,
                    name=tool_name,
                    arguments=(
                        json.dumps(tool_input)
                        if isinstance(tool_input, dict)
                        else str(tool_input)
                    ),
                    server_label=display_name,
                    status="failed" if tool_error else "completed",
                    output=(
                        json.dumps(tool_output)
                        if not isinstance(tool_output, str)
                        else tool_output
                    ),
                    error=tool_error,
                )
            )

    return ResponseObject(
        id=response_id,
        created_at=created_at,
        status="completed",
        model=request_body.model,
        output=output,
        previous_response_id=request_body.previous_response_id,
    )
