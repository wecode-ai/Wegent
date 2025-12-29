# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat response handlers for OpenAPI v1/responses endpoint.
Contains streaming and synchronous response implementations.
"""

import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.user import User
from app.schemas.kind import Task
from app.schemas.openapi_response import (
    OutputMessage,
    OutputTextContent,
    ResponseCreateInput,
    ResponseObject,
)
from app.services.openapi.chat_session import (
    ChatSessionSetup,
    build_chat_history,
    setup_chat_session,
)
from app.services.openapi.mcp import load_mcp_tools

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
    api_trusted_source: Optional[str] = None,
) -> StreamingResponse:
    """
    Create a streaming response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_trusted_source: Optional API trusted source name (from wegent-source header)

    Returns:
        StreamingResponse with SSE events
    """
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
        api_trusted_source,
    )

    response_id = f"resp_{setup.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = setup.assistant_subtask.id
    task_kind_id = setup.task_id

    # Capture tool settings for use in generator
    enable_deep_thinking = tool_settings.get("enable_deep_thinking", False)
    bot_name = setup.bot_name
    bot_namespace = setup.bot_namespace

    async def raw_chat_stream() -> AsyncGenerator[str, None]:
        """Generate raw text chunks from the LLM/Agent and update subtask."""
        import asyncio

        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        from app.api.dependencies import get_db as get_db_session
        from app.chat_shell.messages import MessageConverter
        from app.chat_shell.models import LangChainModelFactory
        from app.core.config import settings
        from app.services.chat.storage import db_handler, session_manager

        accumulated_content = ""
        db_gen = next(get_db_session())
        mcp_client = None

        try:
            cancel_event = await session_manager.register_stream(assistant_subtask_id)
            await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

            # Build messages with history
            history = build_chat_history(setup.existing_subtasks)
            messages = MessageConverter.build_messages(
                history=history,
                current_message=input_text,
                system_prompt=setup.system_prompt,
            )

            # Prepare extra tools (MCP and web search)
            extra_tools = []

            # Load MCP tools if system config enabled
            if settings.CHAT_MCP_ENABLED:
                try:
                    mcp_client = await load_mcp_tools(
                        task_kind_id, bot_name, bot_namespace
                    )
                    if mcp_client:
                        extra_tools.extend(mcp_client.get_tools())
                        logger.info(
                            f"[OPENAPI] Loaded {len(mcp_client.get_tools())} MCP tools for task {task_kind_id}"
                        )
                except Exception as e:
                    logger.warning(f"[OPENAPI] Failed to load MCP tools: {e}")

            # Add web search tool if deep thinking enabled and system config allows
            if enable_deep_thinking and settings.WEB_SEARCH_ENABLED:
                try:
                    from app.chat_shell.tools import WebSearchTool

                    extra_tools.append(WebSearchTool())
                    logger.info(
                        f"[OPENAPI] Added web search tool for task {task_kind_id}"
                    )
                except Exception as e:
                    logger.warning(f"[OPENAPI] Failed to add web search tool: {e}")

            # Decide whether to use agent (with tools) or simple LLM
            use_agent = len(extra_tools) > 0

            if use_agent:
                # Use LangGraph agent for tool support
                from app.chat_shell.agents import LangGraphAgentBuilder
                from app.chat_shell.tools import ToolRegistry

                llm = LangChainModelFactory.create_from_config(
                    setup.model_config, streaming=True
                )

                tool_registry = ToolRegistry()
                for tool in extra_tools:
                    tool_registry.register(tool)

                agent = LangGraphAgentBuilder(
                    llm=llm,
                    tool_registry=tool_registry,
                    max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
                )

                # Stream tokens from agent with periodic saves
                last_redis_save = asyncio.get_event_loop().time()
                last_db_save = asyncio.get_event_loop().time()
                redis_save_interval = getattr(
                    settings, "STREAMING_REDIS_SAVE_INTERVAL", 1.0
                )
                db_save_interval = getattr(settings, "STREAMING_DB_SAVE_INTERVAL", 3.0)

                async for token in agent.stream_tokens(
                    messages, cancel_event=cancel_event
                ):
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        assistant_subtask_id
                    ):
                        logger.info(
                            f"Stream cancelled for subtask {assistant_subtask_id}"
                        )
                        if accumulated_content:
                            await session_manager.save_streaming_content(
                                assistant_subtask_id, accumulated_content
                            )
                            await db_handler.save_partial_response(
                                assistant_subtask_id, accumulated_content
                            )
                        break

                    accumulated_content += token
                    yield token

                    # Periodic saves (same as simple LLM mode)
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_redis_save >= redis_save_interval:
                        await session_manager.save_streaming_content(
                            assistant_subtask_id, accumulated_content
                        )
                        last_redis_save = current_time

                    if current_time - last_db_save >= db_save_interval:
                        await db_handler.save_partial_response(
                            assistant_subtask_id, accumulated_content
                        )
                        last_db_save = current_time
            else:
                # Simple LLM streaming without tools
                try:
                    llm = LangChainModelFactory.create_from_config(
                        setup.model_config, streaming=True
                    )
                except Exception as e:
                    logger.error(f"Failed to create LLM from model config: {e}")
                    await db_handler.update_subtask_status(
                        assistant_subtask_id,
                        "FAILED",
                        error=f"Failed to create LLM: {e}",
                    )
                    return

                # Convert to LangChain messages
                langchain_messages = []
                for msg in messages:
                    role = msg.get("role", "")
                    content = msg.get("content", "")
                    if role == "system":
                        langchain_messages.append(SystemMessage(content=content))
                    elif role == "user":
                        langchain_messages.append(HumanMessage(content=content))
                    elif role == "assistant":
                        langchain_messages.append(AIMessage(content=content))

                # Stream response with periodic saves
                last_redis_save = asyncio.get_event_loop().time()
                last_db_save = asyncio.get_event_loop().time()
                redis_save_interval = getattr(
                    settings, "STREAMING_REDIS_SAVE_INTERVAL", 1.0
                )
                db_save_interval = getattr(settings, "STREAMING_DB_SAVE_INTERVAL", 3.0)

                async for chunk in llm.astream(langchain_messages):
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        assistant_subtask_id
                    ):
                        logger.info(
                            f"Stream cancelled for subtask {assistant_subtask_id}"
                        )
                        if accumulated_content:
                            await session_manager.save_streaming_content(
                                assistant_subtask_id, accumulated_content
                            )
                            await db_handler.save_partial_response(
                                assistant_subtask_id, accumulated_content
                            )
                        break

                    if hasattr(chunk, "content") and chunk.content:
                        accumulated_content += chunk.content
                        yield chunk.content

                        current_time = asyncio.get_event_loop().time()
                        if current_time - last_redis_save >= redis_save_interval:
                            await session_manager.save_streaming_content(
                                assistant_subtask_id, accumulated_content
                            )
                            last_redis_save = current_time

                        if current_time - last_db_save >= db_save_interval:
                            await db_handler.save_partial_response(
                                assistant_subtask_id, accumulated_content
                            )
                            last_db_save = current_time

            # Stream completed (not cancelled)
            if not cancel_event.is_set() and not await session_manager.is_cancelled(
                assistant_subtask_id
            ):
                result = {"value": accumulated_content}

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
            logger.exception(f"Error in raw_chat_stream: {e}")
            try:
                await db_handler.update_subtask_status(
                    assistant_subtask_id, "FAILED", error=str(e)
                )
            except Exception:
                pass
            raise
        finally:
            # Cleanup MCP client if used
            if mcp_client:
                try:
                    await mcp_client.disconnect()
                except Exception as e:
                    logger.warning(f"[OPENAPI] Failed to disconnect MCP client: {e}")

            await session_manager.unregister_stream(assistant_subtask_id)
            await session_manager.delete_streaming_content(assistant_subtask_id)
            db_gen.close()

    async def generate():
        async for event in streaming_service.create_streaming_response(
            response_id=response_id,
            model_string=request_body.model,
            chat_stream=raw_chat_stream(),
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
    api_trusted_source: Optional[str] = None,
) -> ResponseObject:
    """
    Create a synchronous (blocking) response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_trusted_source: Optional API trusted source name (from wegent-source header)

    Returns:
        ResponseObject with completed status and output
    """
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    from sqlalchemy.orm.attributes import flag_modified

    from app.chat_shell.messages import MessageConverter
    from app.chat_shell.models import LangChainModelFactory
    from app.core.config import settings
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
        api_trusted_source,
    )

    response_id = f"resp_{setup.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = setup.assistant_subtask.id

    # Extract tool settings
    enable_deep_thinking = tool_settings.get("enable_deep_thinking", False)

    # Update subtask status to RUNNING
    await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

    accumulated_content = ""
    mcp_client = None

    try:
        # Build messages with history
        history = build_chat_history(setup.existing_subtasks)
        messages = MessageConverter.build_messages(
            history=history,
            current_message=input_text,
            system_prompt=setup.system_prompt,
        )

        # Prepare extra tools (MCP and web search)
        extra_tools = []

        # Load MCP tools if system config enabled
        if settings.CHAT_MCP_ENABLED:
            try:
                mcp_client = await load_mcp_tools(
                    setup.task_id, setup.bot_name, setup.bot_namespace
                )
                if mcp_client:
                    extra_tools.extend(mcp_client.get_tools())
                    logger.info(
                        f"[OPENAPI_SYNC] Loaded {len(mcp_client.get_tools())} MCP tools for task {setup.task_id}"
                    )
            except Exception as e:
                logger.warning(f"[OPENAPI_SYNC] Failed to load MCP tools: {e}")

        # Add web search tool if deep thinking enabled and system config allows
        if enable_deep_thinking and settings.WEB_SEARCH_ENABLED:
            try:
                from app.chat_shell.tools import WebSearchTool

                extra_tools.append(WebSearchTool())
                logger.info(
                    f"[OPENAPI_SYNC] Added web search tool for task {setup.task_id}"
                )
            except Exception as e:
                logger.warning(f"[OPENAPI_SYNC] Failed to add web search tool: {e}")

        # Decide whether to use agent (with tools) or simple LLM
        use_agent = len(extra_tools) > 0

        if use_agent:
            # Use LangGraph agent for tool support
            from app.chat_shell.agents import LangGraphAgentBuilder
            from app.chat_shell.tools import ToolRegistry

            llm = LangChainModelFactory.create_from_config(
                setup.model_config, streaming=True
            )

            tool_registry = ToolRegistry()
            for tool in extra_tools:
                tool_registry.register(tool)

            agent = LangGraphAgentBuilder(
                llm=llm,
                tool_registry=tool_registry,
                max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
            )

            # Stream and accumulate tokens from agent (blocking until complete)
            async for token in agent.stream_tokens(messages):
                accumulated_content += token
        else:
            # Simple LLM streaming without tools
            llm = LangChainModelFactory.create_from_config(
                setup.model_config, streaming=True
            )

            # Convert to LangChain messages
            langchain_messages = []
            for msg in messages:
                role = msg.get("role", "")
                content = msg.get("content", "")
                if role == "system":
                    langchain_messages.append(SystemMessage(content=content))
                elif role == "user":
                    langchain_messages.append(HumanMessage(content=content))
                elif role == "assistant":
                    langchain_messages.append(AIMessage(content=content))

            # Stream and accumulate content (blocking until complete)
            async for chunk in llm.astream(langchain_messages):
                if hasattr(chunk, "content") and chunk.content:
                    accumulated_content += chunk.content

        # Update subtask to completed
        result = {"value": accumulated_content}
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
        logger.exception(f"Error in sync chat response: {e}")
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
            flag_modified(setup.task, "json")
            db.commit()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {error_message}",
        )
    finally:
        # Cleanup MCP client if used
        if mcp_client:
            try:
                await mcp_client.disconnect()
            except Exception as e:
                logger.warning(f"[OPENAPI_SYNC] Failed to disconnect MCP client: {e}")

    # Build response
    message_id = f"msg_{assistant_subtask_id}"

    return ResponseObject(
        id=response_id,
        created_at=created_at,
        status="completed",
        model=request_body.model,
        output=[
            OutputMessage(
                id=message_id,
                status="completed",
                role="assistant",
                content=[OutputTextContent(text=accumulated_content)],
            )
        ],
        previous_response_id=request_body.previous_response_id,
    )
